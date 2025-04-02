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
  ],
  output: {
    filename: 'webrtcperf.js',
    path: path.resolve(__dirname, 'dist'),
    library: 'webrtcperf',
    libraryTarget: 'umd',
  },
};