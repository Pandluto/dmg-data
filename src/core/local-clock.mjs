function nonNegativeInteger(value, label) {
    const number = Number(value);
    if (!Number.isInteger(number) || number < 0) {
        throw new Error(`${label} must be a non-negative integer.`);
    }
    return number;
}

export class LocalClock {
    constructor({ schedule, name = 'local-clock' }) {
        if (typeof schedule !== 'function') throw new Error('LocalClock requires a scheduler.');
        this.schedule = schedule;
        this.name = name;
        this.totalPausedTicks = 0;
        this.pauses = [];
        this.timers = new Map();
        this.nextTimerId = 1;
        this.trace = [{
            frame: 0,
            stage: 'ClockInitialized',
            clock: this.name,
            localFrame: 0
        }];
    }

    localFrameAt(frame) {
        const globalFrame = nonNegativeInteger(frame, 'global frame');
        const pausedBeforeOrAtFrame = this.pauses
            .filter(pause => pause.frame <= globalFrame)
            .reduce((sum, pause) => sum + pause.durationTicks, 0);
        return globalFrame - pausedBeforeOrAtFrame;
    }

    startTimer({ frame, durationTicks, priority = 80, label = '', onComplete }) {
        const startFrame = nonNegativeInteger(frame, 'timer start frame');
        const duration = nonNegativeInteger(durationTicks, 'timer duration');
        if (typeof onComplete !== 'function') {
            throw new Error('LocalClock timer requires an onComplete callback.');
        }
        const timer = {
            id: this.nextTimerId++,
            label,
            startFrame,
            startLocalFrame: this.localFrameAt(startFrame),
            durationTicks: duration,
            deadlineFrame: startFrame + duration,
            priority,
            onComplete,
            generation: 1,
            active: true
        };
        this.timers.set(timer.id, timer);
        this.trace.push({
            frame: startFrame,
            stage: 'TimerStarted',
            clock: this.name,
            timerId: timer.id,
            label,
            durationTicks: duration,
            startLocalFrame: timer.startLocalFrame,
            deadlineFrame: timer.deadlineFrame
        });
        this.#scheduleTimer(timer);
        return timer.id;
    }

    pause({ frame, durationTicks, reason = 'Unspecified', sourceSkillId = null,
        rootSkillId = null, evidenceRuleId = null } = {}) {
        const pauseFrame = nonNegativeInteger(frame, 'pause frame');
        const duration = nonNegativeInteger(durationTicks, 'pause duration');
        if (duration === 0) return null;
        const pause = {
            frame: pauseFrame,
            durationTicks: duration,
            reason,
            sourceSkillId,
            rootSkillId,
            evidenceRuleId
        };
        this.pauses.push(pause);
        this.totalPausedTicks += duration;
        const delayedTimers = [];
        for (const timer of this.timers.values()) {
            if (!timer.active || timer.startFrame > pauseFrame || timer.deadlineFrame < pauseFrame) {
                continue;
            }
            const previousDeadlineFrame = timer.deadlineFrame;
            timer.deadlineFrame += duration;
            timer.generation += 1;
            delayedTimers.push({
                timerId: timer.id,
                label: timer.label,
                previousDeadlineFrame,
                deadlineFrame: timer.deadlineFrame
            });
            this.#scheduleTimer(timer);
        }
        const record = {
            frame: pauseFrame,
            stage: 'ClockPaused',
            clock: this.name,
            localFrameBeforePause: pauseFrame - (this.totalPausedTicks - duration),
            localFrameAfterPause: this.localFrameAt(pauseFrame),
            durationTicks: duration,
            reason,
            sourceSkillId,
            rootSkillId,
            evidenceRuleId,
            delayedTimers
        };
        this.trace.push(record);
        return record;
    }

    cancelTimer(timerId, frame = null, reason = 'Cancelled') {
        const timer = this.timers.get(timerId);
        if (!timer?.active) return false;
        timer.active = false;
        timer.generation += 1;
        this.trace.push({
            frame: frame ?? timer.startFrame,
            stage: 'TimerCancelled',
            clock: this.name,
            timerId,
            label: timer.label,
            reason
        });
        return true;
    }

    timer(timerId) {
        const timer = this.timers.get(timerId);
        if (!timer) return null;
        return {
            id: timer.id,
            label: timer.label,
            startFrame: timer.startFrame,
            startLocalFrame: timer.startLocalFrame,
            durationTicks: timer.durationTicks,
            deadlineFrame: timer.deadlineFrame,
            active: timer.active
        };
    }

    snapshot() {
        return {
            name: this.name,
            totalPausedTicks: this.totalPausedTicks,
            activeTimers: [...this.timers.values()]
                .filter(timer => timer.active)
                .map(timer => this.timer(timer.id))
        };
    }

    #scheduleTimer(timer) {
        const generation = timer.generation;
        const deadlineFrame = timer.deadlineFrame;
        this.schedule(deadlineFrame, timer.priority, () => {
            if (!timer.active
                || timer.generation !== generation
                || timer.deadlineFrame !== deadlineFrame) return;
            timer.active = false;
            this.trace.push({
                frame: deadlineFrame,
                stage: 'TimerCompleted',
                clock: this.name,
                timerId: timer.id,
                label: timer.label,
                startLocalFrame: timer.startLocalFrame,
                durationTicks: timer.durationTicks,
                deadlineFrame
            });
            timer.onComplete(deadlineFrame, timer.id);
        }, `${this.name}:${timer.label || timer.id}`);
    }
}
