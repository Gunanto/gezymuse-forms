import { bootApp } from "./app";

const dataDir = process.env.DATA_DIR || "./data";
const app = await bootApp(dataDir);
const port = Number(process.env.PORT || 3022);

console.log(`GezyForm berjalan di http://localhost:${port} (data: ${dataDir})`);

export default { port, fetch: app.fetch };
