'use strict';
const js = require('@eslint/js');
const globals = require('globals');

module.exports = [
  { ignores: ['node_modules/', 'dist/', 'coverage/'] },
  js.configs.recommended,
  {
    files: ['extension/**/*.js'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'script',
      globals: { ...globals.browser, ...globals.webextensions, YTTR: 'readonly' }
    }
  },
  {
    // Exports through module.exports when loaded by Jest.
    files: ['extension/shared.js'],
    languageOptions: { globals: { module: 'readonly' } }
  },
  {
    // Firefox content scripts get `content` (the page's own fetch etc.).
    files: ['extension/content.js'],
    languageOptions: { globals: { content: 'readonly' } }
  },
  {
    files: ['test/**/*.js'],
    languageOptions: { sourceType: 'commonjs', globals: { ...globals.node, ...globals.jest } }
  },
  {
    files: ['*.config.js'],
    languageOptions: { sourceType: 'commonjs', globals: globals.node }
  }
];
