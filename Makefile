# Glance - top-level build.
#   make            build sysmodule + overlay
#   make dist       build and lay out dist/ exactly like the SD card root
#   make clean
#
# Run from the devkitPro MSYS2 shell on Windows (or any shell with DEVKITPRO set).

PROGRAM_ID := 4200000000474C43
VERSION    := 0.0.3
DIST       := dist

.PHONY: all sysmodule overlay dist clean

all: sysmodule overlay

sysmodule:
	@$(MAKE) --no-print-directory -C sysmodule

overlay:
	@$(MAKE) --no-print-directory -C overlay APP_VERSION=$(VERSION)

dist: all
	@rm -rf $(DIST)
	@mkdir -p $(DIST)/atmosphere/contents/$(PROGRAM_ID)/flags
	@mkdir -p $(DIST)/switch/.overlays
	@mkdir -p $(DIST)/config/glance
	@cp sysmodule/glance-sys.nsp $(DIST)/atmosphere/contents/$(PROGRAM_ID)/exefs.nsp
	@touch $(DIST)/atmosphere/contents/$(PROGRAM_ID)/flags/boot2.flag
	@cp sysmodule/toolbox.json $(DIST)/atmosphere/contents/$(PROGRAM_ID)/toolbox.json
	@cp overlay/glance.ovl $(DIST)/switch/.overlays/glance.ovl
	@cp sd-template/config/glance/config.ini.example $(DIST)/config/glance/config.ini.example
	@echo "SD card layout ready in $(DIST)/ :"
	@cd $(DIST) && find . -type f | sort
	@if command -v zip >/dev/null 2>&1; then \
		rm -f glance-$(VERSION).zip; \
		cd $(DIST) && zip -qr ../glance-$(VERSION).zip . && echo "zipped ... glance-$(VERSION).zip"; \
	fi

clean:
	@$(MAKE) --no-print-directory -C sysmodule clean
	@$(MAKE) --no-print-directory -C overlay clean
	@rm -rf $(DIST) glance-*.zip
