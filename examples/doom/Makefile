# examples/doom/Makefile — Build Doom for the secure-exec sandbox
#
# Targets:
#   build      Download doomgeneric + doom1.wad, compile to WASM
#   clean      Remove build artifacts and downloaded sources
#
# Prerequisites:
#   - wasi-sdk built at native/wasmvm/c/vendor/wasi-sdk/
#     (run `make wasi-sdk` in native/wasmvm/c/ if missing)
#   - wasm-opt (binaryen) on PATH
#   - patched sysroot at native/wasmvm/c/sysroot/ for poll() support
#     (run `make sysroot` in native/wasmvm/c/ if missing)

REPO_ROOT    := $(shell git -C $(dir $(lastword $(MAKEFILE_LIST))) rev-parse --show-toplevel)
WASI_SDK_DIR := $(REPO_ROOT)/native/wasmvm/c/vendor/wasi-sdk
SYSROOT      := $(REPO_ROOT)/native/wasmvm/c/sysroot
CC           := $(WASI_SDK_DIR)/bin/clang

BUILD_DIR    := build
CACHE_DIR    := .cache
SRC_DIR      := $(CACHE_DIR)/doomgeneric/doomgeneric

# doomgeneric source — pinned to a known-good commit
DOOMGENERIC_REPO   := https://github.com/ozkl/doomgeneric
DOOMGENERIC_COMMIT := 3b1d53020373b502035d7d48dede645a7c429feb
DOOMGENERIC_URL    := $(DOOMGENERIC_REPO)/archive/$(DOOMGENERIC_COMMIT).zip

# Shareware WAD (freely distributable by id Software)
WAD_URL := https://distro.ibiblio.org/slitaz/sources/packages/d/doom1.wad

# All doomgeneric engine sources (excluding platform-specific backends)
ENGINE_SRCS := \
	$(SRC_DIR)/dummy.c \
	$(SRC_DIR)/am_map.c \
	$(SRC_DIR)/doomdef.c \
	$(SRC_DIR)/doomstat.c \
	$(SRC_DIR)/dstrings.c \
	$(SRC_DIR)/d_event.c \
	$(SRC_DIR)/d_items.c \
	$(SRC_DIR)/d_iwad.c \
	$(SRC_DIR)/d_loop.c \
	$(SRC_DIR)/d_main.c \
	$(SRC_DIR)/d_mode.c \
	$(SRC_DIR)/d_net.c \
	$(SRC_DIR)/f_finale.c \
	$(SRC_DIR)/f_wipe.c \
	$(SRC_DIR)/g_game.c \
	$(SRC_DIR)/hu_lib.c \
	$(SRC_DIR)/hu_stuff.c \
	$(SRC_DIR)/info.c \
	$(SRC_DIR)/i_cdmus.c \
	$(SRC_DIR)/i_endoom.c \
	$(SRC_DIR)/i_joystick.c \
	$(SRC_DIR)/i_scale.c \
	$(SRC_DIR)/i_sound.c \
	$(SRC_DIR)/i_system.c \
	$(SRC_DIR)/i_timer.c \
	$(SRC_DIR)/memio.c \
	$(SRC_DIR)/m_argv.c \
	$(SRC_DIR)/m_bbox.c \
	$(SRC_DIR)/m_cheat.c \
	$(SRC_DIR)/m_config.c \
	$(SRC_DIR)/m_controls.c \
	$(SRC_DIR)/m_fixed.c \
	$(SRC_DIR)/m_menu.c \
	$(SRC_DIR)/m_misc.c \
	$(SRC_DIR)/m_random.c \
	$(SRC_DIR)/p_ceilng.c \
	$(SRC_DIR)/p_doors.c \
	$(SRC_DIR)/p_enemy.c \
	$(SRC_DIR)/p_floor.c \
	$(SRC_DIR)/p_inter.c \
	$(SRC_DIR)/p_lights.c \
	$(SRC_DIR)/p_map.c \
	$(SRC_DIR)/p_maputl.c \
	$(SRC_DIR)/p_mobj.c \
	$(SRC_DIR)/p_plats.c \
	$(SRC_DIR)/p_pspr.c \
	$(SRC_DIR)/p_saveg.c \
	$(SRC_DIR)/p_setup.c \
	$(SRC_DIR)/p_sight.c \
	$(SRC_DIR)/p_spec.c \
	$(SRC_DIR)/p_switch.c \
	$(SRC_DIR)/p_telept.c \
	$(SRC_DIR)/p_tick.c \
	$(SRC_DIR)/p_user.c \
	$(SRC_DIR)/r_bsp.c \
	$(SRC_DIR)/r_data.c \
	$(SRC_DIR)/r_draw.c \
	$(SRC_DIR)/r_main.c \
	$(SRC_DIR)/r_plane.c \
	$(SRC_DIR)/r_segs.c \
	$(SRC_DIR)/r_sky.c \
	$(SRC_DIR)/r_things.c \
	$(SRC_DIR)/sha1.c \
	$(SRC_DIR)/sounds.c \
	$(SRC_DIR)/statdump.c \
	$(SRC_DIR)/st_lib.c \
	$(SRC_DIR)/st_stuff.c \
	$(SRC_DIR)/s_sound.c \
	$(SRC_DIR)/tables.c \
	$(SRC_DIR)/v_video.c \
	$(SRC_DIR)/wi_stuff.c \
	$(SRC_DIR)/w_checksum.c \
	$(SRC_DIR)/w_file.c \
	$(SRC_DIR)/w_main.c \
	$(SRC_DIR)/w_wad.c \
	$(SRC_DIR)/z_zone.c \
	$(SRC_DIR)/w_file_stdc.c \
	$(SRC_DIR)/i_input.c \
	$(SRC_DIR)/i_video.c \
	$(SRC_DIR)/doomgeneric.c \
	$(SRC_DIR)/icon.c

# Our terminal backend
BACKEND_SRC := c/doomgeneric_terminal.c

WASM_CFLAGS := --target=wasm32-wasip1 \
	--sysroot=$(SYSROOT) \
	-O2 -flto \
	-I $(SRC_DIR) \
	-DNORMALUNIX -DLINUX -DSNDSERV -D_DEFAULT_SOURCE \
	-Wno-implicit-function-declaration \
	-Wno-int-conversion \
	-Wno-return-type \
	-Wno-pointer-sign

NATIVE_CC     := $(shell command -v cc 2>/dev/null || command -v gcc 2>/dev/null || command -v clang 2>/dev/null)
NATIVE_CFLAGS := -O2 -I $(SRC_DIR) \
	-DNORMALUNIX -DLINUX -DSNDSERV -D_DEFAULT_SOURCE \
	-Wno-implicit-function-declaration \
	-Wno-int-conversion \
	-Wno-return-type \
	-Wno-pointer-sign

.PHONY: build native clean fetch

build: $(BUILD_DIR)/doom $(BUILD_DIR)/doom1.wad
	@echo ""
	@echo "Build complete!"
	@echo "  Binary: $(BUILD_DIR)/doom"
	@echo "  WAD:    $(BUILD_DIR)/doom1.wad"
	@echo ""
	@echo "Run with: pnpm start"

native: $(BUILD_DIR)/doom-native $(BUILD_DIR)/doom1.wad
	@echo ""
	@echo "Native build complete!"
	@echo "  Binary: $(BUILD_DIR)/doom-native"
	@echo ""
	@echo "Run with: pnpm start:native"

# --- Fetch doomgeneric source ---

$(SRC_DIR)/doomgeneric.h:
	@echo "=== Downloading doomgeneric ==="
	@mkdir -p $(CACHE_DIR)
	@curl -fSL "$(DOOMGENERIC_URL)" -o "$(CACHE_DIR)/doomgeneric.zip"
	@cd $(CACHE_DIR) && unzip -qo doomgeneric.zip
	@mv "$(CACHE_DIR)/doomgeneric-$(DOOMGENERIC_COMMIT)" "$(CACHE_DIR)/doomgeneric"
	@rm -f "$(CACHE_DIR)/doomgeneric.zip"
	@# Fix out-of-bounds array reads in status bar icon rendering (crashes on WASM).
	@# Replace STlib_updateMultIcon with a bounds-safe version that validates
	@# both oldinum and *inum against the arms[] array size (2 entries).
	@# The approach: add pcount field, guard every mi->p[idx] access.
	@sed -i 's/    int\t\t\tdata;/    int\t\t\tdata;\n    int\t\t\tpcount;/' \
		"$(SRC_DIR)/st_lib.h"
	@sed -i 's/i->data = 0;/i->data = 0;\n    i->pcount = 0;/' \
		"$(SRC_DIR)/st_lib.c"
	@# Guard the oldinum erase path
	@sed -i 's/if (mi->oldinum != -1)/if (mi->oldinum >= 0 \&\& (mi->pcount <= 0 || mi->oldinum < mi->pcount))/' \
		"$(SRC_DIR)/st_lib.c"
	@# Guard the draw path
	@sed -i '/V_DrawPatch(mi->x, mi->y, mi->p\[\*mi->inum\]);/{s/.*/\tint __idx = *mi->inum; if (__idx >= 0 \&\& (mi->pcount <= 0 || __idx < mi->pcount)) V_DrawPatch(mi->x, mi->y, mi->p[__idx]);/}' \
		"$(SRC_DIR)/st_lib.c"
	@# Set pcount for the arms widgets (2 patches each: owned/not-owned)
	@sed -i '/STlib_initMultIcon(\&w_arms\[i\]/,/st_armson);/{s/\&st_armson);/\&st_armson); w_arms[i].pcount = 2;/}' \
		"$(SRC_DIR)/st_stuff.c"
	@echo "doomgeneric source ready (patched)"

fetch: $(SRC_DIR)/doomgeneric.h

# --- Fetch shareware WAD ---

$(BUILD_DIR)/doom1.wad:
	@echo "=== Downloading doom1.wad (shareware) ==="
	@mkdir -p $(BUILD_DIR)
	@curl -fSL "$(WAD_URL)" -o "$(BUILD_DIR)/doom1.wad"
	@echo "doom1.wad ready ($(shell du -h $(BUILD_DIR)/doom1.wad 2>/dev/null | cut -f1 || echo '?'))"

# --- Compile to WASM ---

$(BUILD_DIR)/doom: $(SRC_DIR)/doomgeneric.h $(BACKEND_SRC)
	@echo "=== Compiling Doom to WASM ==="
	@mkdir -p $(BUILD_DIR)
	$(CC) $(WASM_CFLAGS) \
		-Wl,--initial-memory=33554432 \
		-o $(BUILD_DIR)/doom.tmp.wasm \
		$(ENGINE_SRCS) $(BACKEND_SRC)
	@echo "Optimizing with wasm-opt..."
	wasm-opt -O3 --strip-debug $(BUILD_DIR)/doom.tmp.wasm -o $(BUILD_DIR)/doom
	@rm -f $(BUILD_DIR)/doom.tmp.wasm
	@echo "doom binary ready ($(shell du -h $(BUILD_DIR)/doom 2>/dev/null | cut -f1 || echo '?'))"

# --- Compile native (for testing without sandbox) ---

$(BUILD_DIR)/doom-native: $(SRC_DIR)/doomgeneric.h $(BACKEND_SRC)
	@echo "=== Compiling Doom (native) ==="
	@mkdir -p $(BUILD_DIR)
	$(NATIVE_CC) $(NATIVE_CFLAGS) \
		-o $(BUILD_DIR)/doom-native \
		$(ENGINE_SRCS) $(BACKEND_SRC) -lm

clean:
	rm -rf $(BUILD_DIR) $(CACHE_DIR)
