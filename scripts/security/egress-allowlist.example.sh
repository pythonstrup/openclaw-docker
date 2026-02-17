#!/bin/sh
set -eu

# Example only. Review and adapt before use.
# Requires root privileges.

# Allow DNS (replace resolver IP if needed)
iptables -A OUTPUT -p udp --dport 53 -j ACCEPT
iptables -A OUTPUT -p tcp --dport 53 -j ACCEPT

# Allow HTTPS only (you should combine with an IP set managed from allowed domains)
iptables -A OUTPUT -p tcp --dport 443 -j ACCEPT

# Default deny other egress
iptables -A OUTPUT -j DROP
