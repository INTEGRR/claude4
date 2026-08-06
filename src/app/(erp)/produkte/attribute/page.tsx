import { requireArea } from '@/modules/auth'
import { sql } from '@/db/client'
import { ActionForm } from '@/components/action-button'
import { Card, Empty, PageHeader, TableWrap } from '@/components/ui'
import { createAttribute } from '../actions'

export const dynamic = 'force-dynamic'

export default async function AttributePage() {
  await requireArea('produkte')
  const attributes = await sql<{ id: string; name: string; values: string[]; used: number }[]>`
    select a.id, a.name,
           coalesce(array_agg(av.name order by av.sequence) filter (where av.id is not null), '{}') as values,
           (select count(distinct al.template_id) from product_template_attribute_lines al
             where al.attribute_id = a.id)::int as used
    from product_attributes a
    left join product_attribute_values av on av.attribute_id = a.id
    group by a.id, a.name order by a.name`

  return (
    <>
      <PageHeader
        title="Attribute"
        subtitle="Attribute und ihre Werte bilden die Grundlage für Produktvarianten und variantenabhängige Stücklisten"
      />

      <Card title="Neues Attribut">
        <ActionForm action={createAttribute}>
          <div className="row">
            <label className="field">
              <span>Name</span>
              <input name="name" required placeholder="z. B. Farbe" />
            </label>
            <label className="field" style={{ flex: 3 }}>
              <span>Werte (kommagetrennt)</span>
              <input name="values" required placeholder="Weiß, Schwarz, Blau" />
            </label>
            <div className="shrink field">
              <button className="primary" type="submit">Anlegen</button>
            </div>
          </div>
        </ActionForm>
      </Card>

      <Card tight>
        {attributes.length === 0 ? (
          <Empty>Noch keine Attribute.</Empty>
        ) : (
          <TableWrap>
            <table>
              <thead>
                <tr>
                  <th>Attribut</th>
                  <th>Werte</th>
                  <th className="num">Verwendet in</th>
                </tr>
              </thead>
              <tbody>
                {attributes.map((a) => (
                  <tr key={a.id}>
                    <td>{a.name}</td>
                    <td>
                      {a.values.map((v) => (
                        <span key={v} className="badge neutral" style={{ marginRight: 4 }}>{v}</span>
                      ))}
                    </td>
                    <td className="num">{a.used} Produkt(e)</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </TableWrap>
        )}
      </Card>
    </>
  )
}
