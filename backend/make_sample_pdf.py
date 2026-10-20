"""Creates a representative 5-page policy PDF used for the browser acceptance run."""
import os
import pymupdf

BODY_PARAS = [
    ("Renewable energy subsidies for the county's small producers encouraged private "
     "investment and reduced reported emissions, according to several analysts who "
     "reviewed the market data in recent years. The programme attracted manufacturers "
     "to regions that had lost traditional industry and created about four hundred jobs."),
    ("Critics counter that household costs rise when subsidies are funded through "
     "levies, and that grid operators struggle with intermittent supply during calm "
     "winter weeks when demand peaks and solar output is minimal across the region."),
    ("Rural towns remain split on wind projects. Some welcome the investment and jobs; "
     "others object to land use changes and the scale of turbines near primary schools, "
     "especially where access roads cut through farmland."),
    ("The council must decide before the budget review scheduled for later this "
     "quarter, with consultations running across four districts and more than thirty "
     "submissions from residents, businesses and advocacy groups."),
]

HEADER = "Quarterly Policy Review 2026"
FOOTER = "Internal publication"

doc = pymupdf.open()
for i in range(5):
    page = doc.new_page()
    rect = pymupdf.Rect(50, 40, 545, 780)
    text = (f"{HEADER}\n\n" + "\n\n".join(BODY_PARAS) + f"\n(page {i + 1})\n\n{FOOTER}\n{i + 1}\n")
    page.insert_textbox(rect, text, fontsize=12)
out = os.path.join(os.path.dirname(__file__), "..", "docs", "samples", "policy_sim.pdf")
os.makedirs(os.path.dirname(out), exist_ok=True)
doc.save(out)
doc.close()
print("wrote", os.path.abspath(out))
