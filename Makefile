# FoundryVTT MediaSoup WebRTC Makefile
# Provides common development tasks using npm

.PHONY: help install test test-verbose test-ui test-headed coverage lint lint-fix format clean dev build package status security-audit update-deps setup-dev setup-ci qa docs

# Default target
help:
	@echo "FoundryVTT MediaSoup WebRTC Development Commands"
	@echo ""
	@echo "Setup & Environment:"
	@echo "  install     - Install dependencies"
	@echo "  setup-dev   - Setup development environment"
	@echo "  setup-ci    - Setup CI environment"
	@echo ""
	@echo "Build & Development:"
	@echo "  dev         - Start development build with watching"
	@echo "  build       - Build production bundle"
	@echo "  clean       - Clean build artifacts"
	@echo "  package     - Create distribution package"
	@echo ""
	@echo "Testing:"
	@echo "  test        - Run all tests (list reporter, no browser)"
	@echo "  test-verbose - Run all tests with detailed output"
	@echo "  test-ui     - Run tests with UI (opens browser report)"
	@echo "  test-headed - Run tests in headed browser mode"
	@echo "  test-ci     - Run tests in CI mode (matches CI environment)"
	@echo "  test-chromium - Run tests in Chromium only"
	@echo "  test-firefox - Run tests in Firefox only"
	@echo "  coverage    - Run tests with coverage report"
	@echo ""
	@echo "Code Quality & QA:"
	@echo "  qa          - Run complete quality assurance checks"
	@echo "  lint        - Run linting checks"
	@echo "  lint-fix    - Fix auto-fixable linting issues"
	@echo "  format      - Format code (same as lint-fix)"
	@echo ""
	@echo "Maintenance:"
	@echo "  status      - Show project status and health"
	@echo "  security-audit - Run security audit"
	@echo "  update-deps - Update dependencies"
	@echo ""
	@echo "Documentation:"
	@echo "  docs        - Generate documentation (if available)"

# Install dependencies
install:
	npm install

# Setup development environment
setup-dev: install
	@echo "Development environment setup complete"
	@echo "Run 'make dev' to start development server"

# Setup CI environment  
setup-ci: install
	@echo "CI environment setup complete"

# Start development build with watching
dev:
	npm run dev

# Build production bundle
build:
	npm run build

# Clean build artifacts
clean:
	npm run clean
	rm -rf node_modules/.cache
	rm -rf test-results/
	rm -rf playwright-report/
	rm -rf coverage/

# Create distribution package
package: build
	npm run package

# Run all tests (no browser report, matches CI)
test:
	npm test -- --reporter=list

# Run tests with verbose output
test-verbose:
	npm test -- --reporter=line

# Run tests with UI (browser report)
test-ui:
	npm test

# Run tests in headed browser mode (for debugging)
test-headed:
	npm test -- --headed

# Run tests with CI environment (matches CI exactly)
test-ci:
	CI=true npm test

# Run tests for specific browser
test-chromium:
	npm test -- --project=chromium-webrtc

test-firefox:
	npm test -- --project=firefox-webrtc

# Run tests with coverage (if configured)
coverage:
	@echo "Coverage reporting not yet configured"
	@echo "Consider adding nyc or c8 for JavaScript coverage"

# Run linting checks
lint:
	npm run lint

# Fix auto-fixable linting issues
lint-fix:
	npm run lint:fix

# Format code (alias for lint-fix)
format: lint-fix

# Complete quality assurance checks
qa: lint test
	@echo "Quality assurance checks complete"

# Show project status
status:
	@echo "=== Project Status ==="
	@echo "Node.js version: $$(node --version)"
	@echo "npm version: $$(npm --version)"
	@echo "Package version: $$(node -p "require('./package.json').version")"
	@echo ""
	@echo "=== Dependencies ==="
	@npm outdated || true
	@echo ""
	@echo "=== Build Status ==="
	@if [ -f "dist/mediasoup-vtt.js" ]; then \
		echo "✓ Production build exists"; \
		echo "  Size: $$(du -h dist/mediasoup-vtt.js | cut -f1)"; \
	else \
		echo "✗ Production build missing - run 'make build'"; \
	fi
	@if [ -f "dist/mediasoup-vtt-test.js" ]; then \
		echo "✓ Test build exists"; \
	else \
		echo "✗ Test build missing - run 'make build'"; \
	fi

# Run security audit
security-audit:
	npm audit
	@echo ""
	@echo "Consider running 'npm audit fix' for auto-fixable issues"

# Update dependencies
update-deps:
	npm update
	@echo "Dependencies updated. Run 'make test' to verify compatibility"

# Generate documentation (placeholder)
docs:
	@echo "Documentation generation not yet configured"
	@echo "Consider adding JSDoc or similar for API documentation"