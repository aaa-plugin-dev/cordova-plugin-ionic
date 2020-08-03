#! /usr/bin/env bash

cat<<EOF>dist/ngx/package.json
{
  "name": "@aaa-mobile/cordova-plugin-aaa-ionic",
  "main": "ngx/index.js",
  "module": "ngx/index.js",
  "typings": "ngx/index.d.ts"
}
EOF
