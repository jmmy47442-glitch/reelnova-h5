import net from 'node:net';

const defaultHost = process.env.NUXT_HOST || process.env.NITRO_HOST || process.env.HOST || '0.0.0.0';
const defaultPort = process.env.NUXT_PORT || process.env.NITRO_PORT || process.env.PORT || '3000';

const host = process.argv[2] || defaultHost;
const portInput = process.argv[3] || defaultPort;
const port = Number(portInput);

if (!Number.isInteger(port) || port < 1 || port > 65535) {
  console.error('Error: PORT must be a valid TCP port number (1-65535).');
  process.exit(1);
}

const server = net.createServer();

server.once('error', (error) => {
  if (error.code === 'EADDRINUSE') {
    console.error(`Error: port ${port} is already in use. Stop that process or set PORT to another fixed value.`);
    process.exit(1);
  }

  console.error(`Error: cannot listen on ${host}:${port}: ${error.message}`);
  process.exit(1);
});

server.once('listening', () => {
  server.close(() => process.exit(0));
});

server.listen({ host, port, exclusive: true });
