# Vendored libtesla

- Upstream: https://github.com/WerWolv/libtesla
- Commit: `f766e9b607a05e9756843cbd62b3bfb98be1646c` (2023-05-27)
- `example/` removed.

## Local patches (search for `GLANCE PATCH`)

1. `Renderer::initFonts()`: always load the Korean shared font as the fallback
   "local" font when the system language is not Chinese. Upstream only loads
   it when the console language is Korean, so Hangul in Claude's replies would
   render as blanks on an English/Spanish/etc. console.
