# Linux lab for Debug Anything: every Linux provider installed, used to capture fixtures
# and to run the Linux adapters live from a macOS host.
#   docker build -t dea-lab docker/linux-lab
#   docker run --rm -it --privileged -v "$PWD":/dea -w /dea dea-lab bash
FROM node:22-bookworm
RUN apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
      strace gdb lsof tcpdump procps python3 python3-pip linux-perf curl ca-certificates iproute2 \
    && rm -rf /var/lib/apt/lists/* \
    && pip3 install --break-system-packages py-spy
ENV DEA_HOME=/root/.dea
WORKDIR /dea
