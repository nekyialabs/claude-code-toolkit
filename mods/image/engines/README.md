# Writing your own engine

Set `IMAGE_ENGINE=module:/absolute/path/to/my_engine.py`. The file must define one function:

```python
def generate(prompt: str, size: str, quality: str, model: str, refs: list[str]) -> bytes:
    """Return PNG bytes. `refs` are local paths or URLs (empty for plain generation)."""
```

Raise an exception with a short message on failure; the mod reports it to the agent. See `example_engine.py` for the smallest possible engine. Keep credentials in the environment, never in the file, and never print them.
