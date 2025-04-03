import { defineConfig } from 'eslint/config'
import globals from 'globals'
import js from '@eslint/js'
import tseslint from 'typescript-eslint'
import prettier from 'eslint-plugin-prettier'

export default defineConfig([
  {
    files: ['src/*.{js,mjs,cjs,ts}'],
    languageOptions: { globals: globals.browser },
    plugins: { js, prettier },
    extends: ['js/recommended'],
    rules: {
      'prettier/prettier': 'error',
    },
  },
  tseslint.configs.recommended,
])
