import { createRequire } from "node:module";

let VERSION = "0.0.0";
try {
  const require = createRequire(import.meta.url);
  const pkg = require("../package.json");
  VERSION = pkg.version ?? VERSION;
} catch {
  // Fallback if package.json can't be found (e.g., bundled).
}
export { VERSION };
