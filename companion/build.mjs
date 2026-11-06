import { build } from 'esbuild'
await build({ entryPoints: ['src/player-wallet.jsx'], bundle: true, outfile: 'dist/player-wallet.js', format: 'esm', target: ['es2022'], minify: true, define: { 'process.env.NODE_ENV': '"production"' }, legalComments: 'linked' })
await build({ entryPoints: ['src/discord-setup.jsx'], bundle: true, outfile: 'dist/discord-setup.js', format: 'esm', target: ['es2022'], minify: true, define: { 'process.env.NODE_ENV': '"production"' }, legalComments: 'linked' })
await build({ entryPoints: ['src/inventory-shop-checkout.jsx'], bundle: true, outfile: 'dist/inventory-shop-checkout.js', format: 'esm', target: ['es2022'], minify: true, define: { 'process.env.NODE_ENV': '"production"' }, legalComments: 'linked' })
