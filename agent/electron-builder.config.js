/**
 * electron-builder configuration.
 *
 * This lives in a .js file rather than package.json for one reason: npm
 * workspaces hoist `electron` to the repository root node_modules, where
 * electron-builder's version detection does not look. It then refuses to build,
 * because it needs an exact version to download the matching platform binaries
 * and cannot resolve a "^43.4.0" range on its own.
 *
 * Reading the version from the installed package solves it permanently —
 * bumping electron in package.json needs no change here.
 */

const { version: electronVersion } = require('electron/package.json');

module.exports = {
  appId: 'com.overtone.agent',
  productName: 'Overtone',
  copyright: `Copyright © ${new Date().getFullYear()} Kamil Bura`,
  electronVersion,

  directories: {
    output: '../dist',
    buildResources: 'assets',
  },

  files: ['src/**/*', 'ui/**/*', 'assets/**/*', 'package.json'],

  // The transcription worker is a Python script run by a separate interpreter,
  // so it cannot live inside the asar archive — Python cannot read one. It goes
  // beside it, and main.js resolves the path differently once packaged.
  extraResources: [
    { from: '../tools', to: 'tools', filter: ['**/*.py'] },
    // The licence and third-party notices travel with the binary, because the
    // components inside it require their terms to accompany distribution.
    // The wizard tells people to load this folder, so it has to exist beside
    // the installed app rather than only in a checkout.
    { from: '../extension', to: 'extension' },
    // Not in `files`: a surface's pages are served to a browser, so they have
    // to be readable rather than sealed in the asar. Nothing here is loaded
    // until somebody copies it into their own plugins folder.
    { from: 'examples', to: 'examples' },
    { from: '../LICENSE', to: 'LICENSE' },
    { from: '../THIRD-PARTY-NOTICES.md', to: 'THIRD-PARTY-NOTICES.md' },
  ],

  // The agent is a background helper; bundling devDependencies would triple the
  // installer for no benefit.
  npmRebuild: false,

  win: {
    target: [
      { target: 'nsis', arch: ['x64'] },
      { target: 'portable', arch: ['x64'] },
    ],
    icon: 'assets/icon-256.png',
  },

  nsis: {
    oneClick: false,
    perMachine: false,
    allowToChangeInstallationDirectory: true,
    createDesktopShortcut: true,
    createStartMenuShortcut: true,
    shortcutName: 'Overtone',
    // Leaving config and lyrics cache behind on uninstall is surprising.
    deleteAppDataOnUninstall: true,
  },

  portable: {
    artifactName: 'Overtone-${version}-portable.exe',
  },

  linux: {
    target: ['AppImage'],
    category: 'Utility',
    icon: 'assets/icon-256.png',
  },

  mac: {
    target: ['dmg'],
    category: 'public.app-category.utilities',
  },
};
