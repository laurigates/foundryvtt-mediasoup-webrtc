# Task Completion Checklist

When completing a coding task in this project, follow this checklist to ensure quality and consistency.

## Before Starting

- [ ] Understand the requirements and acceptance criteria
- [ ] Identify which files need to be modified
- [ ] Consider impact on existing functionality

## During Development

### Code Changes
- [ ] Follow the code style conventions (4-space indent, single quotes, semicolons)
- [ ] Use appropriate naming conventions (PascalCase for classes, camelCase for functions)
- [ ] Handle errors appropriately
- [ ] Add/update JSDoc comments for public APIs if helpful

### For Frontend Changes (JavaScript)
- [ ] Check that imports/exports are correct ES module syntax
- [ ] Ensure FoundryVTT hooks are used correctly
- [ ] Test with FoundryVTT globals (game, ui, Hooks, etc.)

### For Backend Changes (Rust)
- [ ] Use `cargo fmt` to format code
- [ ] Use `cargo clippy` for linting
- [ ] Handle async operations with Tokio patterns

## Before Committing

### Code Quality Checks

```bash
# JavaScript linting
npm run lint

# Fix auto-fixable issues
npm run lint:fix

# Build to ensure no compilation errors
npm run build
```

### For Rust Changes

```bash
cd server
cargo fmt
cargo clippy
cargo test
```

### Testing

```bash
# Run all tests
npm test

# For integration tests specifically
npm run test:integration

# For server tests
npm run test:server
```

## Commit Guidelines

- Use clear, descriptive commit messages
- Reference issue numbers if applicable
- Keep commits focused on single logical changes

## After Completing

- [ ] Verify the build succeeds: `npm run build`
- [ ] Run tests: `npm test`
- [ ] Lint passes: `npm run lint`
- [ ] For Rust: `cargo test` passes in server/
- [ ] Manual testing if UI/UX changes involved
- [ ] Update documentation if API changes

## Common Issues to Check

1. **Module not appearing in FoundryVTT**: Ensure `module.json` exists in project root
2. **Settings not showing**: Verify `config: true` in settings registration
3. **Build issues**: Run `npm run process-template` to regenerate manifest
4. **WebRTC errors**: Check browser DevTools for permission issues
5. **Server connection**: Verify MediaSoup server is running and accessible
