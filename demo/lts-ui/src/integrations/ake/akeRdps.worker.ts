import { calculateAkeRdps } from './akeRdpsAttribution';
import type { AkeTeamReport } from './akeProvider';
self.onmessage = (event: MessageEvent<AkeTeamReport>) => {
  try { self.postMessage({ result: calculateAkeRdps(event.data) }); }
  catch (error) { self.postMessage({ error: error instanceof Error ? error.message : String(error) }); }
};
