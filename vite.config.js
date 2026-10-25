import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import basicSsl from '@vitejs/plugin-basic-ssl';

export default defineConfig(({ mode }) => ({
  // `npm run dev:phone` serves over HTTPS with a self-signed certificate: phones only allow the
  // microphone on secure pages, and a plain http:// network address doesn't count.
  plugins: [react(), mode === 'phone' && basicSsl()],
  // Listen on the local network so the app can be opened on a phone.
  server: { host: true },
}));
