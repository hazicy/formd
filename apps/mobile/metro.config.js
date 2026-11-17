const { getDefaultConfig } = require('expo/metro-config');
const path = require('node:path');
const config = getDefaultConfig(__dirname);
// Yjs uses lib0/webcrypto for random IDs. Route this import to Expo's
// native implementation instead of lib0's optional isomorphic-webcrypto shim.
config.resolver.resolveRequest = (context, moduleName, platform) => {
  if (moduleName === 'lib0/webcrypto' && platform !== 'web') {
    return {
      type: 'sourceFile',
      filePath: path.resolve(__dirname, 'src/lib/yjs-crypto.ts'),
    };
  }
  return context.resolveRequest(context, moduleName, platform);
};
module.exports = config;
