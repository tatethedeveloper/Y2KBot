// Run the harness headless (browser mode): `npm run web`
import { startServer } from "./server.js";

const srv = await startServer({
  port: Number(process.env.PORT ?? 3000),
  host: process.env.RAM_HOST ?? "127.0.0.1",
});
console.log(`\n  Y2Kbot → http://localhost:${srv.port}`);
console.log(`  default: ${srv.provider} · ${srv.model}${srv.demoMode ? "  (DEMO MODE: that provider isn't configured)" : ""}`);
console.log(`  providers ready: ${srv.providers.filter((p) => p.ready).map((p) => p.id).join(", ") || "none"}`);
console.log(`  windows xp: ${srv.xp.ok ? `ready (accel: ${srv.xp.accel})` : srv.xp.problems.join(" ")}\n`);

const quit = () => { srv.close(); process.exit(0); };
process.on("SIGINT", quit);
process.on("SIGTERM", quit);
