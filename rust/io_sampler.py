#!/usr/bin/env python3
"""Sample /proc/<pid>/io for the ardoise server in a cgroup.
Usage: io_sampler.py <cgroup_dir> <seconds> <out.json>
Prints a table of write_bytes (block I/O) growth per 5 s window."""
import json, os, sys, time

cg, seconds, out = sys.argv[1], float(sys.argv[2]), sys.argv[3]
procs = os.path.join(cg, "cgroup.procs")

def find_pid():
    try:
        for line in open(procs):
            p = line.strip()
            try:
                if open(f"/proc/{p}/comm").read().strip() == "ardoise":
                    return p
            except OSError:
                pass
    except OSError:
        pass
    return None

pid = find_pid()
if not pid:
    sys.exit("no ardoise process in cgroup")
print(f"pid={pid}", flush=True)

rows, t0 = [], time.monotonic()
last = None
while time.monotonic() - t0 < seconds:
    pid = find_pid() or pid
    try:
        io = {}
        for l in open(f"/proc/{pid}/io"):
            parts = l.split()
            if len(parts) == 2:
                io[parts[0].rstrip(":")] = parts[1]
        wb = int(io["write_bytes"])
        rec = {"t": round(time.monotonic() - t0, 1), "rchar": int(io["rchar"]),
               "wchar": int(io["wchar"]), "write_bytes": wb,
               "read_bytes": int(io["read_bytes"])}
        if last:
            rec["delta_wb_mib"] = round((wb - last["write_bytes"]) / 5 / 1048576, 3)
            rec["delta_wchar_mib"] = round((int(io["wchar"]) - last["wchar"]) / 5 / 1048576, 3)
            print(f"t={rec['t']:5.1f}s  block_write={rec['delta_wb_mib']:8.3f} MiB/5s  "
                  f"app_write={rec['delta_wchar_mib']:8.3f} MiB/5s", flush=True)
        rows.append(rec)
        last = rec
    except OSError as e:
        print(f"  (pid gone: {e})", flush=True)
        break
    time.sleep(5)

tot = rows[-1]
json.dump({"pid": pid, "windows": rows,
           "total_write_bytes": tot["write_bytes"],
           "total_wchar": tot["wchar"]}, open(out, "w"), indent=1)
print(f"total: {tot['write_bytes']/1048576:.1f} MiB block writes, "
      f"{tot['wchar']/1048576:.1f} MiB app writes -> {out}", flush=True)
