"""Patch a module right after it is first imported (the fixtures loaded from sitecustomize use it)."""
import importlib.abc
import importlib.machinery


class _PatchOnImport(importlib.abc.MetaPathFinder):
    """Runs a callback on a module right after it executes, and an action when the import system looks it up."""

    def __init__(self, patches, on_lookup):
        self.patches, self.on_lookup = patches, on_lookup

    def find_spec(self, name, path=None, target=None):
        if name in self.on_lookup:
            self.on_lookup[name]()
        if name not in self.patches:
            return None
        spec = importlib.machinery.PathFinder.find_spec(name, path)
        if spec is None or spec.loader is None:
            return None
        loader, patch = spec.loader, self.patches[name]
        original = loader.exec_module

        def exec_module(module):
            original(module)
            patch(module)
        loader.exec_module = exec_module
        return spec

