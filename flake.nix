{
  description = "MusOak web UI: a public frontend that routes to MusOak backends";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
    flake-parts.url = "github:hercules-ci/flake-parts";
  };

  outputs = inputs@{ flake-parts, ... }:
    flake-parts.lib.mkFlake { inherit inputs; } {
      systems = [ "x86_64-linux" "aarch64-linux" "x86_64-darwin" "aarch64-darwin" ];

      perSystem = { pkgs, system, ... }:
        let
          musoak-web = pkgs.buildGoModule {
            pname = "musoak-web";
            version = "0.1.0";
            src = ./.;
            vendorHash = null; # the module imports only the standard library
            # Pure Go: no cgo means no C toolchain, and the DNS resolver works
            # the same on every platform.
            env.CGO_ENABLED = 0;
            # The binary serves the frontend from a directory, so the directory
            # has to come with it: without this a deployment has a server and
            # nothing to serve.
            postInstall = ''
              mkdir -p $out/share/musoak-web
              cp -r web $out/share/musoak-web/
            '';
            meta = with pkgs.lib; {
              description = "MusOak web UI: frontend and router for MusOak backends";
              license = licenses.mit;
              mainProgram = "musoak-web";
            };
          };
        in
        {
          packages.default = musoak-web;
          packages.musoak-web = musoak-web;

          apps.default = {
            type = "app";
            program = "${musoak-web}/bin/musoak-web";
          };

          # The browser suite: a real Firefox, the real server, the real
          # frontend. `nix run .#e2e` from this checkout needs no environment at
          # all - the tools are here, and the server is built from the sibling
          # ../musoak checkout (or pass --musoakd for another build).
          apps.e2e = {
            type = "app";
            program = "${pkgs.writeShellApplication {
              name = "e2e";
              runtimeInputs = [
                pkgs.firefox
                pkgs.geckodriver
                pkgs.ffmpeg # the local tracks the suite makes, and the import path
                pkgs.go # to build musoakd/musoak-web from the checkouts
                (pkgs.python3.withPackages (ps: [ ps.selenium ps.pytest ]))
              ];
              text = ''
                if [ ! -d ./e2e ]; then
                  echo "e2e: run this from the musoak-web checkout (there is no ./e2e here)" >&2
                  exit 1
                fi
                # The sibling checkout's module cache, when it is there, so the
                # builds the suite makes need no network.
                if [ -z "''${GOMODCACHE:-}" ] && [ -d ../musoak/.go/pkg/mod ]; then
                  export GOMODCACHE="$PWD/../musoak/.go/pkg/mod"
                  export GOPATH="$PWD/../musoak/.go"
                fi
                export GOFLAGS="''${GOFLAGS:--mod=mod}"
                # A file - or a `file::test` - names what to collect, and the
                # whole suite is the default. `./e2e` is added only when nothing
                # was named: passed beside a file it would collect the whole
                # suite anyway, which is not what naming a file means.
                named=""
                for arg in "$@"; do
                  case "$arg" in
                    *.py|*::*) named=1 ;;
                  esac
                done
                if [ -z "$named" ]; then
                  set -- ./e2e "$@"
                fi
                exec python3 -m pytest -c ./e2e/pytest.ini "$@"
              '';
            }}/bin/e2e";
          };

          devShells.default = pkgs.mkShell {
            packages = with pkgs; [
              go
              gopls
              gotools
              nodejs # for the frontend's unit tests: node --test web/js/tests/*.test.mjs
            ];
            shellHook = ''
              echo "musoak-web: go build ./... && go test ./..., and node --test web/js/tests/*.test.mjs"
            '';
          };

          checks.build = musoak-web;

          # Both suites, run the way a contributor runs them. The module and
          # the frontend have no dependencies, so this needs no network.
          checks.tests = pkgs.runCommand "musoak-web-tests"
            {
              nativeBuildInputs = [ pkgs.go pkgs.nodejs ];
              src = pkgs.lib.cleanSource ./.;
            } ''
            cp -r $src work
            chmod -R u+w work
            cd work
            export HOME=$TMPDIR
            export GOCACHE=$TMPDIR/go-cache
            export GOPATH=$TMPDIR/gopath
            export GOFLAGS=-mod=mod
            export CGO_ENABLED=0
            go test ./...
            node --test web/js/tests/*.test.mjs
            touch $out
          '';
        };
    };
}
