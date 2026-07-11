import { defineConfig, globalIgnores } from "eslint/config";
import nextTs from "eslint-config-next/typescript";

// Shared flat config for internal source-only packages (no Next app context):
// the TypeScript rule set from eslint-config-next, which is what CI enforced
// on src/** before the monorepo split.
const libraryConfig = defineConfig([
  ...nextTs,
  globalIgnores(["node_modules/**", "dist/**"]),
]);

export default libraryConfig;
