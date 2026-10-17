import os from 'node:os';

console.log(`hello from ${os.hostname()}: ${os.cpus().length} vCPUs, ${Math.round(os.totalmem() / 1024 ** 3)} GiB`);
