# Code Style and Conventions

## JavaScript (Frontend Plugin)

### ESLint Configuration

The project uses ESLint with the following rules:

| Rule | Value | Description |
|------|-------|-------------|
| `indent` | 4 spaces | Use 4-space indentation |
| `linebreak-style` | unix | Use Unix line endings (LF) |
| `quotes` | single | Use single quotes for strings |
| `semi` | always | Always use semicolons |
| `no-unused-vars` | warn | Warn on unused vars, ignore args starting with `_` |
| `no-console` | off | Console statements are allowed |

### Module Format
- **ES Modules**: Use `import`/`export` syntax
- **File Extension**: `.js` for all JavaScript files
- **Source Type**: ES modules with ECMAScript 2022 features

### FoundryVTT Globals
The following globals are available and should not be redeclared:
- `game`, `canvas`, `ui`, `Hooks`, `CONFIG`
- `Actor`, `Item`, `Scene`, `User`, `Roll`, `ChatMessage`
- `Macro`, `Playlist`, `JournalEntry`, `RollTable`, `Folder`
- `Compendium`, `Setting`, `SettingsConfig`, `FormApplication`, `foundry`
- `mediasoupClient` (MediaSoup)
- `$` (jQuery)

### Naming Conventions
- **Classes**: PascalCase (e.g., `MediaSoupVTTClient`)
- **Functions**: camelCase (e.g., `createSendTransport`)
- **Constants**: UPPER_SNAKE_CASE for module-level constants (e.g., `SIG_MSG_TYPES`)
- **Variables**: camelCase
- **Private members**: Prefix with underscore (e.g., `_handleMessage`)

### Code Organization
- One class per file for main classes
- Group related utilities in subdirectories
- Keep UI components in `src/ui/`
- Keep constants in `src/constants/`

## Rust (Backend Server)

### Edition and Style
- **Rust Edition**: 2021
- **Formatting**: Use `cargo fmt`
- **Linting**: Use `cargo clippy`

### Naming Conventions
- **Structs/Enums**: PascalCase
- **Functions/Methods**: snake_case
- **Constants**: UPPER_SNAKE_CASE
- **Modules**: snake_case

### Error Handling
- Use `anyhow` for application errors
- Use `thiserror` for custom error types
- Prefer `?` operator for propagation

### Async Pattern
- Use Tokio runtime for async operations
- Prefer `async`/`await` over raw futures
- Use `DashMap` for concurrent collections

## Testing Conventions

### Playwright Tests
- Test files: `*.spec.js` in `tests/integration/specs/`
- Use `test.describe()` for grouping related tests
- Use `test.beforeEach()` for setup, `test.afterEach()` for cleanup
- Mock FoundryVTT environment using `tests/integration/setup/mock-foundry.js`

### Rust Tests
- Unit tests in same file with `#[cfg(test)]` module
- Integration tests in `server/tests/`
- Use `tokio-test` for async test utilities

## File Headers and Comments
- No mandatory file headers
- Use JSDoc comments for public APIs when helpful
- Keep inline comments minimal and meaningful
- Prefer self-documenting code over comments
