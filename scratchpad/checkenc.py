d = open(r'C:\Users\Kalch\Documents\IXI\site\functions\api\contact.ts', 'rb').read()
print('emdash', d.count(b'\xe2\x80\x94'))
print('middot', d.count(b'\xc2\xb7'))
print('replchar', d.count(b'\xef\xbf\xbd'))
import re
for m in re.finditer(rb"company \|\| .{0,20}", d):
    print('match', m.group(0))
    break