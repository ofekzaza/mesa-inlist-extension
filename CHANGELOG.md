# Changelog

All notable changes to this extension are documented here.

## [1.2.1]

### Fixed
- Columns files now activate the extension (missing `onLanguage:mesa-columns`
  activation event), so autocomplete, hover and validation work there.
- Column/extension icons shifted slightly right.

## [1.2.0]

### Added
- Support for `history_columns.list` / `profile_columns.list` files: syntax
  highlighting, red-marking of unknown columns, completion and hover docs.
- Recognition of prefix-based columns (`center_h1`, `raw_rate_*`, `bc_*`, …)
  and `add_*` / `include` directives.

## [1.1.0]

### Added
- Custom file icon (gold star on navy) shown for inlist files in the explorer and tabs.
- Cross-section config autocomplete: control names (`MLT_option`, `stop_*`, `max_*`, …) are suggested across all namelist sections, tagged with their owning section.
- Trigger characters (`=`, `&`, `'`, `"`, `.`) so value completion appears automatically.
- Namelist-section completion after `&`.
- Value completion: documented string options, logicals, and the control's default value.

## [1.0.0]

### Added
- Syntax highlighting for MESA inlist files (namelist sections, control names, values, comments).
- Validation ("semi-compiler"): red-marking of unknown controls, wrong-section controls, and wrong value types; type + enum-value checking.
- Hover documentation (type, default, options, MESA docs).
- Control database generated from MESA 26.4.1 (7,263 controls across 12 namelists).
- Runtime re-parser to target any MESA version via `mesaInlist.mesaDir`.

