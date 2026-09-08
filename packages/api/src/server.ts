import { createApp } from './app.js';
import { config } from './config.js';

const app = createApp();

// Bind 0.0.0.0: the health probe reaches the container from outside, so
// listening on localhost alone fails the deploy.
const server = app.listen(config.port, '0.0.0.0', () => {
  console.log(`[info] listening on 0.0.0.0:${config.port} (${config.env})`);
});

for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.on(signal, () => {
    console.log(`[info] ${signal} received, closing`);
    server.close(() => process.exit(0));
    // Do not let a hung keep-alive connection block redeployment forever.
    setTimeout(() => process.exit(0), 10_000).unref();
  });
}
