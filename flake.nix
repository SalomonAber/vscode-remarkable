{
  description = "Development environment for the reMarkable Preview VS Code extension";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
    remder.url = "git+https://git.mal.tc/reMder";
  };

  outputs =
    { self, nixpkgs, remder, ... }:
    let
      supportedSystems = [
        "x86_64-linux"
        "aarch64-linux"
      ];
      forAllSystems = nixpkgs.lib.genAttrs supportedSystems;
      version = (builtins.fromJSON (builtins.readFile ./package.json)).version;
    in
    {
      packages = forAllSystems (
        system:
        let
          pkgs = nixpkgs.legacyPackages.${system};
          vsix = pkgs.buildNpmPackage {
            pname = "vscode-remarkable-vsix";
            inherit version;
            src = self;
            npmDepsHash = "sha256-OjoX+6fT109laSKuZ9kBGRef48fhTmxqhVxL7UTZHpU=";
            nativeBuildInputs = [ pkgs.vsce ];
            buildPhase = ''
              runHook preBuild
              echo y | vsce package --no-dependencies --allow-missing-repository
              runHook postBuild
            '';
            installPhase = ''
              install -Dm444 vscode-remarkable-${version}.vsix "$out/vscode-remarkable-${version}.vsix"
            '';
          };
        in
        {
          default = pkgs.vscode-utils.buildVscodeExtension {
            pname = "vscode-remarkable";
            inherit version;
            src = "${vsix}/vscode-remarkable-${version}.vsix";
            vscodeExtPublisher = "undefined";
            vscodeExtName = "vscode-remarkable";
            vscodeExtUniqueId = "undefined.vscode-remarkable";
          };
        }
      );
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
