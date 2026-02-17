#!/bin/sh
set -eu

BASE_DIR="$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"
SECRETS_DIR="$BASE_DIR/secrets"
DISCORD_TOKEN_FILE="$SECRETS_DIR/discord_bot_token.txt"
GATEWAY_TOKEN_FILE="$SECRETS_DIR/gateway_token.txt"
DISCORD_GUILD_ID_FILE="$SECRETS_DIR/discord_guild_id.txt"
DISCORD_CHANNEL_IDS_FILE="$SECRETS_DIR/discord_channel_ids.txt"
DISCORD_USER_IDS_FILE="$SECRETS_DIR/discord_user_ids.txt"

mkdir -p "$SECRETS_DIR"
chmod 700 "$SECRETS_DIR"

if [ ! -f "$DISCORD_TOKEN_FILE" ]; then
  printf "Paste Discord bot token: " >&2
  stty -echo
  IFS= read -r TOKEN
  stty echo
  printf "\n" >&2

  if [ -z "$TOKEN" ]; then
    echo "empty token; aborted" >&2
    exit 1
  fi

  umask 177
  printf "%s" "$TOKEN" > "$DISCORD_TOKEN_FILE"
  chmod 600 "$DISCORD_TOKEN_FILE"
  echo "created $DISCORD_TOKEN_FILE"
else
  echo "secret file already exists: $DISCORD_TOKEN_FILE"
fi

if [ ! -f "$GATEWAY_TOKEN_FILE" ]; then
  if command -v openssl >/dev/null 2>&1; then
    GATEWAY_TOKEN="$(openssl rand -hex 32)"
  else
    GATEWAY_TOKEN="$(node -e 'console.log(require(\"crypto\").randomBytes(32).toString(\"hex\"))')"
  fi
  umask 177
  printf "%s" "$GATEWAY_TOKEN" > "$GATEWAY_TOKEN_FILE"
  chmod 600 "$GATEWAY_TOKEN_FILE"
  echo "created $GATEWAY_TOKEN_FILE"
else
  echo "secret file already exists: $GATEWAY_TOKEN_FILE"
fi

prompt_numeric_secret() {
  label="$1"
  file="$2"
  allow_list="${3:-false}"
  if [ -f "$file" ]; then
    echo "secret file already exists: $file"
    return 0
  fi
  if [ "$allow_list" = "true" ]; then
    printf "Paste %s (numeric IDs, comma-separated): " "$label" >&2
  else
    printf "Paste %s (numeric Discord ID): " "$label" >&2
  fi
  IFS= read -r VALUE
  if [ "$allow_list" = "true" ]; then
    NORMALIZED="$(printf '%s' "$VALUE" | tr '\n' ',' | tr -d ' ' | sed 's/,,*/,/g; s/^,//; s/,$//')"
    [ -n "$NORMALIZED" ] || { echo "invalid $label (empty)" >&2; exit 1; }
    OLDIFS="$IFS"; IFS=','
    for id in $NORMALIZED; do
      case "$id" in ''|*[!0-9]*) echo "invalid $label (must be numeric IDs)" >&2; IFS="$OLDIFS"; exit 1;; esac
    done
    IFS="$OLDIFS"
    VALUE="$NORMALIZED"
  else
    case "$VALUE" in
      ''|*[!0-9]*)
        echo "invalid $label (must be numeric)" >&2
        exit 1
        ;;
    esac
  fi
  umask 177
  printf "%s" "$VALUE" > "$file"
  chmod 600 "$file"
  echo "created $file"
}

prompt_numeric_secret "Discord Guild ID" "$DISCORD_GUILD_ID_FILE"
prompt_numeric_secret "Discord Channel IDs" "$DISCORD_CHANNEL_IDS_FILE" "true"
prompt_numeric_secret "Discord User IDs" "$DISCORD_USER_IDS_FILE" "true"
