import { emdashPluginTest } from "@emdash-cms/plugin-test/config";
import { defineConfig } from "vitest/config";

export default defineConfig({
	plugins: [emdashPluginTest()],
	test: {
		// A throwaway key so the host can encrypt the API token setting.
		env: { EMDASH_ENCRYPTION_KEY: "emdash_enc_v1_8KfPE_fdTpUq0mYMERFu94sHJve2NPMuOpaMxsfygIs" },
	},
});
