#!/bin/sh
# The daemon for the phone E2E, on the folder run.sh made (E2E_DIR).
: "${E2E_DIR:?run this through run.sh}"
export CREW_HOME="$E2E_DIR/home" CREW_WEB_DIST="$E2E_DIR/dist" PATH="$E2E_DIR/bin:/usr/bin:/bin:/usr/sbin:/sbin"
exec "$E2E_DIR/bin/crew" daemon
