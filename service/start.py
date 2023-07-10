import os
import sys

sys.path.insert(0, os.path.dirname(__file__))
print(sys.executable, file=sys.stderr)

import azservice.__main__ 