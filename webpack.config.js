const path = require('path');
const webpack = require('webpack');

module.exports = {
  entry: './src/index.ts',
  module: {
    rules: [
      {
        test: /\.ts$/,
        use: 'ts-loader',
        exclude: /node_modules/,
      },
    ],
  },
  resolve: {
    extensions: ['.ts', '.js'],
    fallback: {
      "fs": false,
      "path": false,
      "os": false
    },
  },
  mode: 'production',
  plugins: [
    new webpack.DefinePlugin({
      'process.env.VERSION': JSON.stringify(process.env.npm_package_version),
    }),
    new webpack.BannerPlugin({
      raw: true,
      footer: true,
      banner: `;(function (g) {
if (!g.webrtcperf) return;
var lib = Object.freeze(g.webrtcperf);
Object.defineProperty(g, 'webrtcperf', {
  get: () => lib,
  set: () => {},
  configurable: false,
});
})(typeof globalThis !== 'undefined' ? globalThis : this);`,
    }),
  ],
  output: {
    filename: 'webrtcperf.js',
    path: path.resolve(__dirname, 'dist'),
    library: { name: 'webrtcperf', type: 'window' },
    globalObject: 'globalThis',
  },
};