from sys import stdin, stdout, stderr

def flush_output(output):
    print('flush_output ================= ', file=stderr)
    stdout.write(output + '\n')
    stdout.flush()
    stderr.flush()

# def write(output):
#     print('flush_output ================= ', file=stderr)
#     flush_output(output)