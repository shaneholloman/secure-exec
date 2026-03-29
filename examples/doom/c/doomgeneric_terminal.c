/*
 * doomgeneric_terminal.c — Terminal backend for doomgeneric
 *
 * Renders the Doom framebuffer to a terminal using Unicode half-block
 * characters (U+2580 ▀) with 24-bit ANSI true-color escape codes.
 * Each character cell encodes two vertical pixels: the top pixel as
 * foreground color and the bottom pixel as background color.
 *
 * The 640x400 framebuffer is downscaled via area-averaging to fit the
 * terminal (default 120 columns, configurable via COLUMNS env var).
 * Frame rate is capped at ~30 fps to avoid flooding the terminal.
 *
 * Input is read from stdin via poll()+read() (non-blocking).
 * The host is expected to put the terminal in raw mode before launching.
 *
 * Pure POSIX — no WASI-specific code, no termios (host manages raw mode).
 */

#include "doomgeneric.h"
#include "doomkeys.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>
#include <unistd.h>
#include <poll.h>

/* --- Configuration --- */

/* Target terminal width in columns. Override with COLUMNS env var. */
#define DEFAULT_TERM_COLS 80

/* Frame rate cap (ms per frame). 33ms ≈ 30fps. */
#define FRAME_MIN_MS 33

/* Computed at init */
static int term_cols;          /* output columns */
static int term_rows;          /* output rows (half of vertical pixels) */

/* --- Timing --- */

static struct timespec start_time;
static uint32_t last_frame_ms;

static uint32_t now_ms(void)
{
    struct timespec now;
    clock_gettime(CLOCK_MONOTONIC, &now);
    long ds  = now.tv_sec  - start_time.tv_sec;
    long dns = now.tv_nsec - start_time.tv_nsec;
    if (dns < 0) { ds--; dns += 1000000000L; }
    return (uint32_t)(ds * 1000 + dns / 1000000);
}

void DG_Init(void)
{
    clock_gettime(CLOCK_MONOTONIC, &start_time);
    last_frame_ms = 0;

    /* Determine output size — fit to terminal width, preserve aspect ratio */
    const char *cols_env = getenv("COLUMNS");
    term_cols = cols_env ? atoi(cols_env) : DEFAULT_TERM_COLS;
    if (term_cols < 40) term_cols = 40;
    if (term_cols > DOOMGENERIC_RESX) term_cols = DOOMGENERIC_RESX;

    /* Rows: maintain Doom's 320:200 (8:5) aspect ratio.
     * Each output row covers 2 vertical pixels (half-block), so:
     *   term_rows = term_cols * (200/320) / 2 = term_cols * 5/16 */
    term_rows = term_cols * 5 / 16;
    if (term_rows < 10) term_rows = 10;

    /* Hide cursor, switch to alternate screen buffer, clear */
    fprintf(stdout, "\033[?1049h\033[?25l\033[2J");
    fflush(stdout);
}

uint32_t DG_GetTicksMs(void)
{
    return now_ms();
}

void DG_SleepMs(uint32_t ms)
{
    struct timespec ts;
    ts.tv_sec  = ms / 1000;
    ts.tv_nsec = (ms % 1000) * 1000000L;
    nanosleep(&ts, NULL);
}

/* --- Rendering --- */

/*
 * Output buffer sized for downscaled frame.
 * At 120 cols x 50 rows, worst case ~44 bytes/cell: ~264KB per frame.
 */
#define OUTPUT_BUF_SIZE (512 * 1024)
static char output_buf[OUTPUT_BUF_SIZE];

/*
 * Sample a source pixel at the given output coordinate.
 * Maps output coords to source coords via simple nearest-neighbor.
 */
static uint32_t sample_pixel(int out_x, int out_y)
{
    int sx = out_x * DOOMGENERIC_RESX / term_cols;
    int sy = out_y * DOOMGENERIC_RESY / (term_rows * 2);
    if (sx >= DOOMGENERIC_RESX) sx = DOOMGENERIC_RESX - 1;
    if (sy >= DOOMGENERIC_RESY) sy = DOOMGENERIC_RESY - 1;
    return DG_ScreenBuffer[sy * DOOMGENERIC_RESX + sx];
}

void DG_DrawFrame(void)
{
    /* Frame rate cap */
    uint32_t elapsed = now_ms();
    if ((elapsed - last_frame_ms) < FRAME_MIN_MS) return;
    last_frame_ms = elapsed;

    char *p = output_buf;

    /* Move cursor to top-left */
    p += sprintf(p, "\033[H");

    /* Track previous colors to skip redundant escape sequences */
    int prev_fg_r = -1, prev_fg_g = -1, prev_fg_b = -1;
    int prev_bg_r = -1, prev_bg_g = -1, prev_bg_b = -1;

    for (int row = 0; row < term_rows; row++)
    {
        for (int col = 0; col < term_cols; col++)
        {
            /* Top half of the character cell (upper pixel row) */
            uint32_t top = sample_pixel(col, row * 2);
            /* Bottom half (lower pixel row) */
            uint32_t bot = sample_pixel(col, row * 2 + 1);

            int fg_r = (top >> 16) & 0xFF;
            int fg_g = (top >>  8) & 0xFF;
            int fg_b = (top >>  0) & 0xFF;
            int bg_r = (bot >> 16) & 0xFF;
            int bg_g = (bot >>  8) & 0xFF;
            int bg_b = (bot >>  0) & 0xFF;

            /* Only emit color codes when they change */
            if (fg_r != prev_fg_r || fg_g != prev_fg_g || fg_b != prev_fg_b)
            {
                p += sprintf(p, "\033[38;2;%d;%d;%dm", fg_r, fg_g, fg_b);
                prev_fg_r = fg_r; prev_fg_g = fg_g; prev_fg_b = fg_b;
            }
            if (bg_r != prev_bg_r || bg_g != prev_bg_g || bg_b != prev_bg_b)
            {
                p += sprintf(p, "\033[48;2;%d;%d;%dm", bg_r, bg_g, bg_b);
                prev_bg_r = bg_r; prev_bg_g = bg_g; prev_bg_b = bg_b;
            }

            /* UTF-8 encoding of U+2580 (▀): 0xE2 0x96 0x80 */
            *p++ = (char)0xE2;
            *p++ = (char)0x96;
            *p++ = (char)0x80;
        }

        /* Reset colors at end of line, newline */
        p += sprintf(p, "\033[0m\r\n");
        prev_fg_r = prev_fg_g = prev_fg_b = -1;
        prev_bg_r = prev_bg_g = prev_bg_b = -1;
    }

    /* Reset all attributes */
    p += sprintf(p, "\033[0m");

    /* Single write for the whole frame */
    fwrite(output_buf, 1, (size_t)(p - output_buf), stdout);
    fflush(stdout);
}

/* --- Input --- */

/*
 * Terminal input has no key-up events. We simulate held keys by:
 * - On keypress: send press event, record the key and timestamp
 * - On each DG_GetKey poll: release keys that haven't been re-pressed
 *   within KEY_HOLD_MS milliseconds
 * - If the same key arrives again before timeout, reset its timer (held)
 */
#define KEY_HOLD_MS 150
#define MAX_HELD_KEYS 16

#define KEY_QUEUE_SIZE 64
static struct { int pressed; unsigned char key; } key_queue[KEY_QUEUE_SIZE];
static int key_queue_head = 0;
static int key_queue_tail = 0;

static struct { unsigned char key; uint32_t press_time; } held_keys[MAX_HELD_KEYS];
static int held_count = 0;

static void enqueue_key(int pressed, unsigned char key)
{
    int next = (key_queue_head + 1) % KEY_QUEUE_SIZE;
    if (next == key_queue_tail) return;
    key_queue[key_queue_head].pressed = pressed;
    key_queue[key_queue_head].key = key;
    key_queue_head = next;
}

static void press_key(unsigned char key)
{
    /* Check if already held — if so, just refresh the timer */
    for (int i = 0; i < held_count; i++)
    {
        if (held_keys[i].key == key)
        {
            held_keys[i].press_time = now_ms();
            return; /* already pressed, no new press event */
        }
    }

    /* New key press */
    enqueue_key(1, key);

    if (held_count < MAX_HELD_KEYS)
    {
        held_keys[held_count].key = key;
        held_keys[held_count].press_time = now_ms();
        held_count++;
    }
}

static void release_expired_keys(void)
{
    uint32_t t = now_ms();
    int i = 0;
    while (i < held_count)
    {
        if ((t - held_keys[i].press_time) >= KEY_HOLD_MS)
        {
            enqueue_key(0, held_keys[i].key);
            /* Remove by swapping with last */
            held_keys[i] = held_keys[held_count - 1];
            held_count--;
        }
        else
        {
            i++;
        }
    }
}

static unsigned char stdin_buf[64];
static int stdin_len = 0;
static int stdin_pos = 0;

static int read_stdin_byte(void)
{
    if (stdin_pos < stdin_len)
        return (unsigned char)stdin_buf[stdin_pos++];

    struct pollfd pfd;
    pfd.fd = STDIN_FILENO;
    pfd.events = POLLIN;
    pfd.revents = 0;

    if (poll(&pfd, 1, 0) <= 0)
        return -1;

    ssize_t n = read(STDIN_FILENO, stdin_buf, sizeof(stdin_buf));
    if (n <= 0)
        return -1;

    stdin_len = (int)n;
    stdin_pos = 1;
    return (unsigned char)stdin_buf[0];
}

static void process_input(void)
{
    for (;;)
    {
        int ch = read_stdin_byte();
        if (ch < 0) break;

        /* ESC sequence */
        if (ch == 0x1B)
        {
            int ch2 = read_stdin_byte();
            if (ch2 < 0) {
                press_key(KEY_ESCAPE);
                break;
            }
            if (ch2 == '[')
            {
                int ch3 = read_stdin_byte();
                if (ch3 < 0) break;
                switch (ch3) {
                    case 'A': press_key(KEY_UPARROW);    break;
                    case 'B': press_key(KEY_DOWNARROW);  break;
                    case 'C': press_key(KEY_RIGHTARROW); break;
                    case 'D': press_key(KEY_LEFTARROW);  break;
                    default: break;
                }
            }
            else if (ch2 == 'O')
            {
                int ch3 = read_stdin_byte();
                if (ch3 < 0) break;
            }
            continue;
        }

        unsigned char doom_key = 0;
        switch (ch) {
            case '\r':
            case '\n':  doom_key = KEY_ENTER;      break;
            case '\t':  doom_key = KEY_TAB;         break;
            case ' ':   doom_key = KEY_USE;         break;
            case 'f':
            case 'F':   doom_key = KEY_FIRE;        break;
            case 'r':
            case 'R':   doom_key = KEY_RSHIFT;      break; /* run */
            case ',':
            case 'a':   doom_key = KEY_STRAFE_L;    break; /* strafe left */
            case '.':
            case 'd':   doom_key = KEY_STRAFE_R;    break; /* strafe right */
            case 'w':   doom_key = KEY_UPARROW;     break; /* WASD alt */
            case 's':   doom_key = KEY_DOWNARROW;   break; /* WASD alt */
            case 0x7F:
            case 0x08:  doom_key = KEY_BACKSPACE;   break;
            /* 0x03 (Ctrl+C) and 'q' intercepted by host for clean exit */
            default:
                if (ch >= 'A' && ch <= 'Z')
                    doom_key = (unsigned char)(ch - 'A' + 'a');
                else if (ch >= '0' && ch <= '9')
                    doom_key = (unsigned char)ch;
                else if (ch == '-' || ch == '=')
                    doom_key = (unsigned char)ch;
                break;
        }

        if (doom_key != 0)
            press_key(doom_key);
    }
}

int DG_GetKey(int *pressed, unsigned char *doom_key)
{
    process_input();
    release_expired_keys();

    if (key_queue_tail == key_queue_head)
        return 0;

    *pressed  = key_queue[key_queue_tail].pressed;
    *doom_key = key_queue[key_queue_tail].key;
    key_queue_tail = (key_queue_tail + 1) % KEY_QUEUE_SIZE;
    return 1;
}

/* --- Window title (no-op) --- */

void DG_SetWindowTitle(const char *title)
{
    (void)title;
}

/* --- Cleanup on exit --- */

static void cleanup(void)
{
    fputs("\033[?25h\033[?1049l", stdout);
    fflush(stdout);
}

/* --- Stubs for missing POSIX functions in WASI --- */

int system(const char *command)
{
    (void)command;
    return -1;
}

/* --- Main --- */

int main(int argc, char **argv)
{
    atexit(cleanup);
    doomgeneric_Create(argc, argv);

    for (;;)
    {
        doomgeneric_Tick();
    }

    return 0;
}
