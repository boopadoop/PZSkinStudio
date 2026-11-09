// The "PZ Skin Studio" program for Linux: double-click it to open the studio in a window of its own.
// It runs start-studio.py --app from the folder the program sits in, which serves the studio to this
// computer and opens it in Chrome, Edge or Chromium's app mode. Any arguments are passed along, so
// `"./PZ Skin Studio" --install` adds it to the applications menu.
//
// Built by tools/build-launcher.sh.
#include <errno.h>
#include <libgen.h>
#include <limits.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/wait.h>
#include <unistd.h>

// Started from a file manager or the menu there's no terminal, so problems are shown in a window.
static void tell(const char *message) {
    fprintf(stderr, "PZ Skin Studio: %s\n", message);
    pid_t child = fork();
    if (child == 0) {
        execlp("zenity", "zenity", "--error", "--title", "PZ Skin Studio", "--text", message, (char *)NULL);
        execlp("notify-send", "notify-send", "PZ Skin Studio", message, (char *)NULL);
        _exit(127);
    }
    if (child > 0) waitpid(child, NULL, 0);
}

int main(int argc, char **argv) {
    char self[PATH_MAX];
    ssize_t length = readlink("/proc/self/exe", self, sizeof self - 1);
    if (length < 0) {
        tell("Couldn't tell which folder this program is in.");
        return 1;
    }
    self[length] = '\0';
    char *folder = dirname(self);

    char script[PATH_MAX];
    if (snprintf(script, sizeof script, "%s/start-studio.py", folder) >= (int)sizeof script || access(script, R_OK) != 0) {
        tell("start-studio.py is missing. Keep this program in the studio folder, next to PZSkinStudio.html and start-studio.py.");
        return 1;
    }

    char **args = calloc((size_t)argc + 4, sizeof *args);
    if (!args) return 1;
    int n = 0;
    args[n++] = "python3";
    args[n++] = script;
    args[n++] = "--app";
    for (int i = 1; i < argc; i++) args[n++] = argv[i];
    args[n] = NULL;
    execvp("python3", args);

    char message[512];
    snprintf(message, sizeof message, "Couldn't start Python 3 (%s). Install it with your package manager, for example: sudo apt install python3", strerror(errno));
    tell(message);
    return 1;
}
