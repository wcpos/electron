/**
 * Base webpack config used across other specific configs
 */

import webpack from 'webpack';
import webpackPaths from './webpack.paths';
import { dependencies as externals } from '../../release/app/package.json';

const configuration: webpack.Configuration = {
  externals: [...Object.keys(externals || {})],

  stats: 'errors-only',

  module: {
    rules: [
      {
        test: /\.[jt]sx?$/,
        exclude: /node_modules\/(?!(@wcpos|react-native|@react-native(-community)?|react-native-reanimated|react-native-gesture-handler)\/).*/,
        use: {
          loader: 'babel-loader',
          options: {
            presets: ['@wcpos/babel-preset-expo'],
            plugins: [
              'react-native-reanimated/plugin',
            ]
          },
          // loader: 'ts-loader',
          // options: {
          //   // Remove this line to enable type checking in webpack builds
          //   transpileOnly: true,
          // },
        },
      },
    ],
  },

  output: {
    path: webpackPaths.srcPath,
    // https://github.com/webpack/webpack/issues/1114
    library: {
      type: 'commonjs2',
    },
  },

  /**
   * Determine the array of extensions that should be used to resolve modules.
   */
  resolve: {
    extensions: [
      '.electron.js',
      '.electron.ts',
      '.electron.tsx',
      '.web.mjs',
      '.mjs',
      '.web.js',
      '.js',
      '.web.ts',
      '.ts',
      '.web.tsx',
      '.tsx',
      '.json',
      '.web.jsx',
      '.jsx',
    ],
    modules: [webpackPaths.srcPath, 'node_modules'],
    alias: {
      'react-native': 'react-native-web'
    }
  },

  plugins: [
    new webpack.EnvironmentPlugin({
      NODE_ENV: 'production',
    }),
    new webpack.DefinePlugin({
      // fix __DEV__ not defined error for react-native-gesture-handler
      __DEV__: process.env.NODE_ENV !== 'production' || true,
      // 'process.env': JSON.stringify(process.env)
    }),
    // new webpack.ProvidePlugin({
    //   // fix "process is not defined" error for react-native-reanimated
    //   // (do "npm install process" before running the build)
    //   process: 'process/browser',
    // })
  ],
};

export default configuration;
