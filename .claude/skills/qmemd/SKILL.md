```markdown
# qmemd Development Patterns

> Auto-generated skill from repository analysis

## Overview
This skill teaches the core development patterns and workflows used in the `qmemd` TypeScript codebase. It covers file naming, import/export styles, commit conventions, and testing practices. By following these guidelines, contributors can maintain consistency and quality across the project.

## Coding Conventions

### File Naming
- Use **camelCase** for file names.
  - Example: `myModule.ts`, `userService.ts`

### Import Style
- Use **relative imports** for internal modules.
  - Example:
    ```typescript
    import { myFunction } from './utils';
    ```

### Export Style
- Use **named exports**.
  - Example:
    ```typescript
    // In utils.ts
    export function myFunction() { /* ... */ }

    // In another file
    import { myFunction } from './utils';
    ```

### Commit Patterns
- Commit messages are **freeform** (no strict prefixes).
- Average commit message length: ~46 characters.
  - Example:
    ```
    Fix bug in memory allocation logic
    ```

## Workflows

### Testing Code
**Trigger:** When you want to run the test suite to verify changes.
**Command:** `/test`

1. Ensure you have installed dependencies: `npm install`
2. Run the tests using Vitest:
    ```bash
    npx vitest
    ```
3. Review the output for any failed tests.

### Adding a New Module
**Trigger:** When you need to add new functionality.
**Command:** `/add-module`

1. Create a new file using camelCase, e.g., `newFeature.ts`.
2. Use named exports for all functions or classes.
    ```typescript
    export function newFeature() { /* ... */ }
    ```
3. Import the module using a relative path where needed.
    ```typescript
    import { newFeature } from './newFeature';
    ```
4. Write a corresponding test file: `newFeature.test.ts`.
5. Run `/test` to ensure all tests pass.

## Testing Patterns

- **Framework:** [Vitest](https://vitest.dev/)
- **Test file pattern:** Files end with `.test.ts`
- **Example test:**
    ```typescript
    // myFunction.test.ts
    import { describe, it, expect } from 'vitest';
    import { myFunction } from './myFunction';

    describe('myFunction', () => {
      it('should return true for valid input', () => {
        expect(myFunction('valid')).toBe(true);
      });
    });
    ```

## Commands
| Command      | Purpose                                      |
|--------------|----------------------------------------------|
| /test        | Run the test suite with Vitest               |
| /add-module  | Scaffold a new module with tests             |
```
