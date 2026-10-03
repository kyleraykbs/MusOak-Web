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

          devShells.default = pkgs.mkShell {
            packages = with pkgs; [
              go
              gopls
              gotools
              nodejs # for the frontend's unit tests: node --test
            ];
            shellHook = ''
              echo "musoak-web: go build ./... && go test ./..., and node --test web/js/tests"
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
