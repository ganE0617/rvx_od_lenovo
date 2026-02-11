#!/bin/bash
# Quick start script for edge agent

cd "$(dirname "$0")"

if [ ! -f ".env" ]; then
    echo "Creating .env from .env.example..."
    cp .env.example .env
    echo "⚠️  Please edit .env with your settings before running"
    exit 1
fi

echo "Starting Edge Agent..."
node dist/index.js
