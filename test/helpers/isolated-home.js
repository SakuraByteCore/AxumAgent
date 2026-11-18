import os from "node:os";
import { syncBuiltinESMExports } from "node:module";

// Companion tests explicitly redirect HOME; Windows homedir() otherwise ignores it.
if (process.platform === "win32") {
  const homedir = os.homedir;
  os.homedir = () => process.env.HOME || homedir();
  syncBuiltinESMExports();
}
