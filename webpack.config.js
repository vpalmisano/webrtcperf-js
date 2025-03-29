const path = require('path');

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
  },
  mode: 'production',
  output: {
    filename: 'webrtcperf.js',
    path: path.resolve(__dirname, 'dist'),
    library: 'webrtcperf',
    libraryTarget: 'umd',
  },
};