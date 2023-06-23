sudo rm -r ./_build

meson _build --prefix=/usr
sudo ninja install -C ./_build
