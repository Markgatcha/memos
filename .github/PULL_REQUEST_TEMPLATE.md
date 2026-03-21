## Summary

Brief description of what this PR does.

Fixes #(issue number)

## Type of Change

- [ ] Bug fix (non-breaking change that fixes an issue)
- [ ] New feature (non-breaking change that adds functionality)
- [ ] New adapter (adds a MemOS adapter for a new framework/tool)
- [ ] Breaking change (fix or feature that would cause existing functionality to change)
- [ ] Documentation update
- [ ] CI/build improvements

## Changes Made

- 
- 
- 

## Testing

Describe the tests you ran and how to reproduce them:

```bash
# Run existing tests
npm test

# Or for Python
pytest tests/
```

- [ ] All existing tests pass
- [ ] I've added tests for new functionality
- [ ] I've tested manually with a local MemOS instance

## Checklist

- [ ] My code follows the project's style guidelines (`npm run lint` passes)
- [ ] I've updated the relevant documentation (README, docs/, JSDoc/docstrings)
- [ ] My changes don't introduce any cloud dependencies or telemetry
- [ ] I've reviewed my own diff before requesting a review

## Adapter Checklist (if this is a new adapter)

- [ ] Adapter extends `BaseAdapter` from `src/adapters/base.ts`
- [ ] Adapter has a README in `adapters/`
- [ ] Adapter is listed in the README adapter table
- [ ] Adapter has at least one integration test
