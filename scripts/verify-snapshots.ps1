Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$ProjectRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$LockPath = Join-Path $ProjectRoot 'sources.lock.json'
$ConsistencyCheck = Join-Path $ProjectRoot 'scripts/check-repository-consistency.mjs'

if (-not (Test-Path -LiteralPath $LockPath -PathType Leaf)) {
    throw 'sources.lock.json is missing. Run sync-public-data.ps1 first.'
}

& node $ConsistencyCheck
if ($LASTEXITCODE -ne 0) {
    throw "Repository consistency check failed with exit code $LASTEXITCODE"
}

$lock = Get-Content -LiteralPath $LockPath -Raw -Encoding UTF8 | ConvertFrom-Json
$failures = [System.Collections.Generic.List[string]]::new()
$jsonCount = 0

foreach ($source in $lock.sources) {
    $target = [System.IO.Path]::GetFullPath((Join-Path $ProjectRoot ([string]$source.path)))
    $prefix = $ProjectRoot.TrimEnd([System.IO.Path]::DirectorySeparatorChar) + [System.IO.Path]::DirectorySeparatorChar
    if (-not $target.StartsWith($prefix, [System.StringComparison]::OrdinalIgnoreCase)) {
        $failures.Add("unsafe path in lock: $($source.path)")
        continue
    }
    if (-not (Test-Path -LiteralPath $target -PathType Leaf)) {
        $failures.Add("missing: $($source.path)")
        continue
    }

    $actualHash = (Get-FileHash -LiteralPath $target -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($actualHash -ne [string]$source.sha256) {
        $failures.Add("hash mismatch: $($source.path)")
    }

    if ([System.IO.Path]::GetExtension($target) -eq '.json') {
        try {
            Get-Content -LiteralPath $target -Raw -Encoding UTF8 | ConvertFrom-Json | Out-Null
            $jsonCount++
        }
        catch {
            $failures.Add("invalid JSON: $($source.path): $($_.Exception.Message)")
        }
    }
}

$authoredJson = @(
    'fixtures/pelica-pulse.expected.json',
    'fixtures/calc/pelica-heavy-combo-skill.request.json',
    'fixtures/calc/pelica-heavy-combo-skill.response.json',
    'fixtures/calc/pelica-heavy-combo-skill.oracle.json',
    'fixtures/calc/pelica-heavy-combo-skill.manifest.json',
    'fixtures/calc/pelica-combo-boundaries.oracle.json',
    'fixtures/calc/pelica-combo-boundaries.manifest.json',
    'fixtures/calc/pelica-resource-boundaries.oracle.json',
    'fixtures/calc/pelica-resource-boundaries.manifest.json',
    'fixtures/calc/pelica-poise-boundaries.oracle.json',
    'fixtures/calc/pelica-poise-boundaries.manifest.json',
    'fixtures/calc/poise-guard-boundaries.oracle.json',
    'fixtures/calc/poise-guard-boundaries.manifest.json',
    'spec/engine-semantic-mappings.json',
    'spec/unresolved-dependencies.json',
    'package.json',
    'reference/public-data/akedata/table-corpus.manifest.json',
    'reference/public-data/akedata/runtime-corpus.manifest.json',
    'derived/cleanroom/ake-action-coverage.json',
    'derived/cleanroom/pelica-model.json',
    'derived/cleanroom/pelica-simulation.json',
    'derived/cleanroom/pelica-poise-execution-simulation.json'
)

foreach ($relativePath in $authoredJson) {
    $target = Join-Path $ProjectRoot $relativePath
    try {
        Get-Content -LiteralPath $target -Raw -Encoding UTF8 | ConvertFrom-Json | Out-Null
        $jsonCount++
    }
    catch {
        $failures.Add("invalid project JSON: ${relativePath}: $($_.Exception.Message)")
    }
}

$fixtureManifestPaths = @(
    'fixtures/calc/pelica-heavy-combo-skill.manifest.json',
    'fixtures/calc/pelica-combo-boundaries.manifest.json',
    'fixtures/calc/pelica-resource-boundaries.manifest.json',
    'fixtures/calc/pelica-poise-boundaries.manifest.json'
    'fixtures/calc/poise-guard-boundaries.manifest.json'
)
foreach ($relativeManifestPath in $fixtureManifestPaths) {
    $fixtureManifestPath = Join-Path $ProjectRoot $relativeManifestPath
    try {
        $fixtureManifest = Get-Content -LiteralPath $fixtureManifestPath -Raw -Encoding UTF8 | ConvertFrom-Json
        foreach ($record in $fixtureManifest.files) {
            $fixturePath = [System.IO.Path]::GetFullPath((Join-Path $ProjectRoot ([string]$record.path)))
            $prefix = $ProjectRoot.TrimEnd([System.IO.Path]::DirectorySeparatorChar) + [System.IO.Path]::DirectorySeparatorChar
            if (-not $fixturePath.StartsWith($prefix, [System.StringComparison]::OrdinalIgnoreCase)) {
                $failures.Add("unsafe fixture path: $($record.path)")
                continue
            }
            if (-not (Test-Path -LiteralPath $fixturePath -PathType Leaf)) {
                $failures.Add("fixture missing: $($record.path)")
                continue
            }
            $fixtureHash = (Get-FileHash -LiteralPath $fixturePath -Algorithm SHA256).Hash.ToLowerInvariant()
            if ($fixtureHash -ne [string]$record.sha256) {
                $failures.Add("fixture hash mismatch: $($record.path)")
            }
            if ((Get-Item -LiteralPath $fixturePath).Length -ne [long]$record.bytes) {
                $failures.Add("fixture byte length mismatch: $($record.path)")
            }
        }
    }
    catch {
        $failures.Add("invalid Calc fixture manifest ${relativeManifestPath}: $($_.Exception.Message)")
    }
}

$derivedRecordCount = 0
$derivedManifestPath = Join-Path $ProjectRoot 'derived/ake-analysis/manifest.json'
if (-not (Test-Path -LiteralPath $derivedManifestPath -PathType Leaf)) {
    $failures.Add('derived analysis manifest is missing; run export-ake-analysis.mjs')
}
else {
    try {
        $derivedManifest = Get-Content -LiteralPath $derivedManifestPath -Raw -Encoding UTF8 | ConvertFrom-Json
        $jsonCount++
        foreach ($record in $derivedManifest.records) {
            $derivedRecordCount++
            $outputPath = [System.IO.Path]::GetFullPath((Join-Path $ProjectRoot ([string]$record.outputPath)))
            $rawPath = [System.IO.Path]::GetFullPath((Join-Path $ProjectRoot ([string]$record.rawPath)))
            $analyzerPath = [System.IO.Path]::GetFullPath((Join-Path $ProjectRoot ([string]$record.analyzerPath)))
            $prefix = $ProjectRoot.TrimEnd([System.IO.Path]::DirectorySeparatorChar) + [System.IO.Path]::DirectorySeparatorChar

            foreach ($candidate in @($outputPath, $rawPath, $analyzerPath)) {
                if (-not $candidate.StartsWith($prefix, [System.StringComparison]::OrdinalIgnoreCase)) {
                    $failures.Add("unsafe derived path: $candidate")
                }
            }
            if (-not (Test-Path -LiteralPath $outputPath -PathType Leaf)) {
                $failures.Add("derived output missing: $($record.outputPath)")
                continue
            }
            if (-not (Test-Path -LiteralPath $rawPath -PathType Leaf)) {
                $failures.Add("derived raw input missing: $($record.rawPath)")
                continue
            }
            if (-not (Test-Path -LiteralPath $analyzerPath -PathType Leaf)) {
                $failures.Add("derived analyzer missing: $($record.analyzerPath)")
                continue
            }

            $outputHash = (Get-FileHash -LiteralPath $outputPath -Algorithm SHA256).Hash.ToLowerInvariant()
            $rawHash = (Get-FileHash -LiteralPath $rawPath -Algorithm SHA256).Hash.ToLowerInvariant()
            $analyzerHash = (Get-FileHash -LiteralPath $analyzerPath -Algorithm SHA256).Hash.ToLowerInvariant()
            if ($outputHash -ne [string]$record.outputSha256) {
                $failures.Add("derived output hash mismatch: $($record.outputPath)")
            }
            if ($rawHash -ne [string]$record.rawSha256) {
                $failures.Add("derived raw hash mismatch: $($record.rawPath)")
            }
            if ($analyzerHash -ne [string]$record.analyzerSha256) {
                $failures.Add("derived analyzer hash mismatch: $($record.analyzerPath)")
            }

            try {
                $derivedDocument = Get-Content -LiteralPath $outputPath -Raw -Encoding UTF8 | ConvertFrom-Json
                $jsonCount++
                if ([string]$derivedDocument._meta.id -ne [string]$record.id) {
                    $failures.Add("derived id mismatch: $($record.outputPath)")
                }
                if ([string]$derivedDocument._meta.kind -ne [string]$record.kind) {
                    $failures.Add("derived kind mismatch: $($record.outputPath)")
                }
            }
            catch {
                $failures.Add("invalid derived JSON: $($record.outputPath): $($_.Exception.Message)")
            }
        }
        if ([int]$derivedManifest.recordCount -ne $derivedRecordCount) {
            $failures.Add('derived manifest recordCount does not match records')
        }
    }
    catch {
        $failures.Add("invalid derived manifest: $($_.Exception.Message)")
    }
}

$spellBurstSettingTerm = -join @(
    [char]0x6cd5, [char]0x672f, [char]0x7206, [char]0x53d1,
    [char]0x4f24, [char]0x5bb3, [char]0x500d, [char]0x7387
)
$conductSettingName = -join @(
    [char]0x5bfc, [char]0x7535, [char]0x6cd5, [char]0x672f,
    [char]0x4f24, [char]0x5bb3, [char]0x63d0, [char]0x9ad8
)
$conductSettingTerm = '"' + $conductSettingName + '"'

$semanticChecks = @(
    @{ Path = 'reference/public-data/akedata/Json/SkillData/chr_0004_pelica_normal_skill.json'; Terms = @('SpellInfliction', 'Pulse', 'buff_common_obtain_ultimate_sp') }
    @{ Path = 'reference/public-data/akedata/Json/SkillData/chr_0004_pelica_ultimate_skill.json'; Terms = @('UltimateSp', 'abilityentity_chr_0004_pelica_ultimate_skill', 'DamageAction') }
    @{ Path = 'reference/public-data/akedata/Json/BuffData/buff_common_obtain_ultimate_sp.json'; Terms = @('ObtainUspInNormalSkill', 'usp_everyone', '"valueDouble": 6.5') }
    @{ Path = 'reference/public-data/akedata/Json/BuffData/buff_common_energy_shard_attached_pulse.json'; Terms = @('EnhanceAndRefresh', 'buff_common_pulse_pulse_triggered', 'OnBuffAfterTryEnhanced') }
    @{ Path = 'reference/public-data/akedata/Json/BuffData/buff_common_pulse_pulse_triggered.json'; Terms = @('TriggerSpellBurstEventAction', 'ReadSkillSettingData', $spellBurstSettingTerm) }
    @{ Path = 'reference/public-data/akedata/TableCfg/CcTagTable.json'; Terms = @('global_buff_cc_chr_main_attribute_down') }
    @{ Path = 'derived/ake-analysis/BuffData/buff_common_energy_shard_attached_pulse.analyzed.json'; Terms = @('"value": 20', 'CreateBuffAction', 'buff_common_pulse_pulse_triggered') }
    @{ Path = 'derived/ake-analysis/SkillData/chr_0004_pelica_normal_skill.analyzed.json'; Terms = @('"source": "patch"', '"value": 1.78', 'SpellInfliction') }
    @{ Path = 'derived/cleanroom/pelica-model.json'; Terms = @('SkillPatchTable.level1', '"pendingDurationTicks": 180', $conductSettingTerm, '"ultimateSkillId": "chr_0004_pelica_ultimate_skill"', '"ratePerSecond": 8') }
    @{ Path = 'derived/cleanroom/pelica-simulation.json'; Terms = @('"totalDamage": 183.1976648', '"defenderZoneScale": 1.12', '"PENDING_CREATED"', '"Atb": 268.8000035881996', '"PassiveRecovery"') }
    @{ Path = 'fixtures/calc/pelica-combo-boundaries.oracle.json'; Terms = @('"same-frame-as-hit"', '"reported-expiry-frame"', '"second-trigger-during-cooldown"') }
    @{ Path = 'fixtures/calc/pelica-resource-boundaries.oracle.json'; Terms = @('"baseline-empty-usp"', '"second-normal-skill-resets-delay"', '"ultimate-from-full-usp"', '6.499999761581421') }
    @{ Path = 'fixtures/calc/pelica-poise-boundaries.oracle.json'; Terms = @('"exact-threshold-breaks"', '"overflow-threshold-breaks"', '"execution-gate-is-single-use"', 'buff_common_mini_poise_break', '218.0126') }
    @{ Path = 'fixtures/calc/poise-guard-boundaries.oracle.json'; Terms = @('"minimum-scalar-baseline"', '"guard-expiry-event-frame-hit"', '"first-post-guard-hit"', '0.5999999046325684', '0.7333330512046814') }
    @{ Path = 'reference/public-data/akedata/Json/BuffData/buff_common_poise_guard.json'; Terms = @('PoiseDamageTakenScalar', 'FinalMultiplier', 'poiseTakenScalar') }
    @{ Path = 'derived/cleanroom/pelica-model.json'; Terms = @('"breakingAttackId": "chr_0004_pelica_power_attack"', '"maxPoise": 160', '"brokenDamageScale": 1.3', 'PoiseDamageRule') }
    @{ Path = 'derived/cleanroom/pelica-poise-execution-simulation.json'; Terms = @('"stage": "Broken"', '"stage": "ExecutionConsumed"', '"poiseDamage": 15', '"finalDamage": 218.0126', '"reason": "BreakingAttack"') }
)

foreach ($check in $semanticChecks) {
    $target = Join-Path $ProjectRoot $check.Path
    if (-not (Test-Path -LiteralPath $target -PathType Leaf)) {
        $failures.Add("semantic check missing: $($check.Path)")
        continue
    }
    $content = Get-Content -LiteralPath $target -Raw -Encoding UTF8
    foreach ($term in $check.Terms) {
        if ($content.IndexOf($term, [System.StringComparison]::Ordinal) -lt 0) {
            $failures.Add("semantic term '$term' missing from $($check.Path)")
        }
    }
}

if ($failures.Count -gt 0) {
    $failures | ForEach-Object { Write-Error $_ }
    throw "Snapshot verification failed with $($failures.Count) problem(s)."
}

$assetIndexPath = Join-Path $ProjectRoot 'reference/public-data/akedata/asset-sync-index.json'
$assetIndex = Get-Content -LiteralPath $assetIndexPath -Raw -Encoding UTF8 | ConvertFrom-Json
$assetPaths = $assetIndex.datasets.json.files.PSObject.Properties.Name
$assetGroups = $assetPaths | ForEach-Object { ($_ -split '/')[0] } | Group-Object | Sort-Object Name
$groupSummary = ($assetGroups | ForEach-Object { "$($_.Name)=$($_.Count)" }) -join ', '
$hasGlobalBuffData = $assetGroups.Name -contains 'GlobalBuffData'

Write-Host "Verified $($lock.sources.Count) files, including $jsonCount JSON documents."
Write-Host 'Verified Pelica Pulse and CC reference invariants.'
Write-Host "Verified $derivedRecordCount derived AKE analysis documents and their provenance hashes."
Write-Host 'Verified Pelica clean-room model and simulation artifacts.'
Write-Host 'Verified Pelica combo and ATB/USP boundary fixtures.'
Write-Host 'Verified Pelica poise, knot and execution boundary fixtures.'
Write-Host 'Verified current Calc rapid-break guard and local-clock boundary fixtures.'
Write-Host "AKE JSON inventory: $groupSummary"
Write-Host "GlobalBuffData present in public index: $hasGlobalBuffData"
