{
  description = "Barestash development environment";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
  };

  outputs =
    { nixpkgs, ... }:
    let
      systems = [
        "aarch64-darwin"
        "aarch64-linux"
        "x86_64-darwin"
        "x86_64-linux"
      ];

      forAllSystems =
        callback:
        builtins.listToAttrs (
          map (
            system:
            let
              pkgs = import nixpkgs { inherit system; };
            in
            {
              name = system;
              value = callback pkgs;
            }
          ) systems
        );

      pythonCommands =
        pkgs: with pkgs; [
          python3
          (writeShellScriptBin "python" ''
            exec ${python3}/bin/python3 "$@"
          '')
        ];
    in
    {
      devShells = forAllSystems (pkgs: {
        default = pkgs.mkShell {
          packages =
            with pkgs;
            [
              deadnix
              git
              gh
              jq
              just
              nixfmt
              nodejs_24
              pnpm
            ]
            ++ pythonCommands pkgs
            ++ (with pkgs; [
              ripgrep
              statix
            ]);
        };
      });

      formatter = forAllSystems (
        pkgs:
        pkgs.writeShellApplication {
          name = "nixfmt";
          runtimeInputs = [ pkgs.nixfmt ];
          text = ''
            if [ "$#" -eq 0 ]; then
              exec nixfmt flake.nix
            fi

            exec nixfmt "$@"
          '';
        }
      );

      checks = forAllSystems (pkgs: {
        nix-quality =
          pkgs.runCommandLocal "barestash-nix-quality"
            {
              nativeBuildInputs = with pkgs; [
                deadnix
                nixfmt
                statix
              ];
              src = ./.;
            }
            ''
              cp -R "$src" source
              chmod -R +w source
              cd source

              nixfmt --check flake.nix
              statix check flake.nix
              deadnix --fail flake.nix

              touch "$out"
            '';

        dev-shell-python =
          pkgs.runCommandLocal "barestash-dev-shell-python"
            {
              nativeBuildInputs = pythonCommands pkgs;
            }
            ''
              command -v python3 >/dev/null
              command -v python >/dev/null
              python3 --version >/dev/null
              python --version >/dev/null
              test "$(python -c 'print(1 + 1)')" = "2"

              touch "$out"
            '';
      });
    };
}
