// The v2 tool groups (docs/mcp-v2/DESIGN.md §6). Each module exports kit → { specs, handlers }; tools-core.js
// createCoreTools(ctx, { extensions: V2_EXTENSIONS }) merges them into the one registry. The kit carries
// tools-core's own place, time and "about" helpers, so v2 tools parse inputs exactly like v1 tools.
import { findTools } from './find.js';
import { slipTools } from './slip.js';
import { missionTools } from './mission.js';

export const V2_EXTENSIONS = [findTools, slipTools, missionTools];
