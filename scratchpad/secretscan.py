import os
leaked = False
for root,_,files in os.walk('C:/Users/Kalch/Documents/IXI/site/dist'):
    for f in files:
        p = os.path.join(root,f)
        try:
            data = open(p,'rb').read()
        except Exception:
            continue
        for pat in [b'TURNSTILE_SECRET_KEY', b'RESEND_API_KEY']:
            if pat in data:
                print('LEAK:',p); leaked=True
if not leaked:
    print('clean - no leaked secret names in dist')