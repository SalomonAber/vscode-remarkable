{
  description = "Development environment for the reMarkable Preview VS Code extension";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
    remder.url = "git+https://git.mal.tc/reMder";
  };

  outputs =
    { nixpkgs, remder, ... }:
    let
      supportedSystems = [
        "x86_64-linux"
        "aarch64-linux"
      ];
      forAllSystems = nixpkgs.lib.genAttrs supportedSystems;
    in
    {
      devShells = forAllSystems (
        system:
        let
          pkgs = nixpkgs.legacyPackages.${system};
        in
        {
          default = pkgs.mkShell {
            packages = [
              pkgs.nodejs_22
              remder.packages.${system}.default
            ];
          };
        }
      );
    };
}