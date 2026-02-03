import js from '@eslint/js';

export default [
    {
        files: ['src/**/*.js'],
        languageOptions: {
            ecmaVersion: 2022,
            sourceType: 'module',
            globals: {
                // Browser globals
                window: 'readonly',
                document: 'readonly',
                console: 'readonly',
                navigator: 'readonly',
                WebSocket: 'readonly',
                MediaStream: 'readonly',
                URL: 'readonly',
                setTimeout: 'readonly',
                clearTimeout: 'readonly',
                setInterval: 'readonly',
                clearInterval: 'readonly',
                $: 'readonly',
                
                // FoundryVTT globals
                game: 'readonly',
                canvas: 'readonly',
                ui: 'readonly',
                Hooks: 'readonly',
                CONFIG: 'readonly',
                Actor: 'readonly',
                Item: 'readonly',
                Scene: 'readonly',
                User: 'readonly',
                Roll: 'readonly',
                ChatMessage: 'readonly',
                Macro: 'readonly',
                Playlist: 'readonly',
                JournalEntry: 'readonly',
                RollTable: 'readonly',
                Folder: 'readonly',
                Compendium: 'readonly',
                Setting: 'readonly',
                SettingsConfig: 'readonly',
                FormApplication: 'readonly',
                foundry: 'readonly',
                
                // MediaSoup globals
                mediasoupClient: 'readonly'
            }
        },
        rules: {
            ...js.configs.recommended.rules,
            'indent': ['error', 4],
            'linebreak-style': ['error', 'unix'],
            'quotes': ['error', 'single'],
            'semi': ['error', 'always'],
            'no-unused-vars': ['warn', { 'argsIgnorePattern': '^_', 'varsIgnorePattern': '^_', 'caughtErrorsIgnorePattern': '^_' }],
            'no-console': 'off'
        }
    },
    {
        files: ['tests/**/*.js'],
        languageOptions: {
            ecmaVersion: 2022,
            sourceType: 'module',
            globals: {
                // Browser globals
                window: 'readonly',
                document: 'readonly',
                console: 'readonly',
                navigator: 'readonly',
                WebSocket: 'readonly',
                MediaStream: 'readonly',
                
                // Test globals (Playwright)
                test: 'readonly',
                expect: 'readonly',
                page: 'readonly',
                browser: 'readonly',
                
                // FoundryVTT test globals
                game: 'readonly',
                Hooks: 'readonly'
            }
        },
        rules: {
            ...js.configs.recommended.rules,
            'indent': ['error', 2],
            'linebreak-style': ['error', 'unix'],
            'quotes': ['error', 'single'],
            'semi': ['error', 'always'],
            'no-unused-vars': ['warn', { 'argsIgnorePattern': '^_', 'varsIgnorePattern': '^_', 'caughtErrorsIgnorePattern': '^_' }],
            'no-console': 'off'
        }
    }
];